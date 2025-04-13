const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const DEFAULT_DATA_FILE = path.join(__dirname, "mcp.json");

// Store connected SSE clients by sessionId
const clients = new Map();

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize sessions file if it doesn't exist
if (!fs.existsSync(SESSIONS_FILE)) {
  fs.writeFileSync(
    SESSIONS_FILE,
    JSON.stringify(
      {
        sessions: {},
      },
      null,
      2
    )
  );
}

// Initialize default data file with default structure if it doesn't exist
if (!fs.existsSync(DEFAULT_DATA_FILE)) {
  fs.writeFileSync(
    DEFAULT_DATA_FILE,
    JSON.stringify(
      {
        project_name: "Website",
        phase: "init",
        current_task: "",
        project_context: {},
      },
      null,
      2
    )
  );
}

// Middleware
app.use(cors());
app.use(express.json());

// Helper functions for session operations
const readSessions = () => {
  try {
    const rawData = fs.readFileSync(SESSIONS_FILE);
    return JSON.parse(rawData);
  } catch (error) {
    console.error("Error reading sessions file:", error);
    return { sessions: {} };
  }
};

const writeSessions = (data) => {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error writing sessions file:", error);
  }
};

const getSessionFile = (sessionId) => {
  return path.join(DATA_DIR, `${sessionId}.json`);
};

const createSession = () => {
  const sessionId = uuidv4();
  const sessionsData = readSessions();

  // Create session entry
  sessionsData.sessions[sessionId] = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    lastAccess: new Date().toISOString(),
  };

  writeSessions(sessionsData);

  // Create session data file with default data
  const defaultData = readData(DEFAULT_DATA_FILE);
  writeData(getSessionFile(sessionId), {
    ...defaultData,
    session_id: sessionId,
  });

  return sessionId;
};

const validateSession = (sessionId) => {
  if (!sessionId) return false;

  const sessionsData = readSessions();
  if (!sessionsData.sessions[sessionId]) return false;

  // Update last access time
  sessionsData.sessions[sessionId].lastAccess = new Date().toISOString();
  writeSessions(sessionsData);

  return true;
};

// Helper functions for file operations
const readData = (filePath = DEFAULT_DATA_FILE) => {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        project_name: "Untitled",
        phase: "init",
        current_task: "",
        project_context: {},
      };
    }

    const rawData = fs.readFileSync(filePath);
    return JSON.parse(rawData);
  } catch (error) {
    console.error(`Error reading data file ${filePath}:`, error);
    return {
      project_name: "Untitled",
      phase: "init",
      current_task: "",
      project_context: {},
    };
  }
};

const writeData = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error writing data file ${filePath}:`, error);
  }
};

// Send SSE updates to all connected clients for a specific session
const sendUpdate = (sessionId, eventType, data) => {
  const eventData = JSON.stringify(data);
  const sessionClients = clients.get(sessionId) || [];

  sessionClients.forEach((client) => {
    client.write(`event: ${eventType}\n`);
    client.write(`data: ${eventData}\n\n`);
  });
};

// SSE endpoint for clients to subscribe
app.get("/events", (req, res) => {
  const sessionId = req.query.sessionId;

  // Validate session
  if (!validateSession(sessionId)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid session ID",
    });
  }

  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial data
  const data = readData(getSessionFile(sessionId));

  // Send 'initialized' event for Copilot Agent to complete connection
  res.write(`event: message\n`);
  res.write(
    `data: ${JSON.stringify({
      type: "initialized",
      status: "ok",
      sessionId,
    })}\n\n`
  );

  res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${Date.now()}\n\n`);
  }, 10000);

  // Add client to the session's clients
  if (!clients.has(sessionId)) {
    clients.set(sessionId, new Set());
  }
  clients.get(sessionId).add(res);

  // Remove client when connection is closed
  req.on("close", () => {
    const sessionClients = clients.get(sessionId);
    if (sessionClients) {
      sessionClients.delete(res);
      if (sessionClients.size === 0) {
        clients.delete(sessionId);
      }
    }
    clearInterval(interval);
    console.log(
      `Client disconnected from session ${sessionId}, total connected:`,
      sessionClients ? sessionClients.size : 0
    );
  });

  console.log(
    `New client connected to session ${sessionId}, total connected:`,
    clients.get(sessionId).size
  );
});

// Session management endpoints
app.post("/sessions", (req, res) => {
  const sessionId = createSession();
  res.json({
    status: "success",
    sessionId,
    message: "Session created successfully",
  });
});

app.get("/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  if (!validateSession(sessionId)) {
    return res.status(404).json({
      status: "error",
      message: "Session not found",
    });
  }

  const sessionsData = readSessions();
  const sessionData = readData(getSessionFile(sessionId));

  res.json({
    status: "success",
    session: {
      ...sessionsData.sessions[sessionId],
      data: sessionData,
    },
  });
});

app.get("/sessions", (req, res) => {
  const sessionsData = readSessions();
  res.json({
    status: "success",
    sessions: sessionsData.sessions,
  });
});

// API Endpoints with session support
app.get("/project", (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    // Backward compatibility: use default data file
    const data = readData();
    return res.json(data);
  }

  if (!validateSession(sessionId)) {
    return res.status(404).json({
      status: "error",
      message: "Session not found",
    });
  }

  const data = readData(getSessionFile(sessionId));
  res.json(data);
});

app.post("/", async (req, res) => {
  const { command, sessionId, ...body } = req.body;

  if (!command) {
    return res.status(400).json({
      status: "error",
      message: "Missing 'command' in request",
    });
  }

  // Verify session if provided
  if (sessionId && !validateSession(sessionId)) {
    return res.status(404).json({
      status: "error",
      message: "Session not found",
    });
  }

  // Determine which file to use
  const dataFile = sessionId ? getSessionFile(sessionId) : DEFAULT_DATA_FILE;

  // Command handling
  if (command === "generate") {
    const { prompt } = body;

    if (!prompt) {
      return res.status(400).json({
        status: "error",
        message: "Missing 'prompt'",
      });
    }

    const response = `The MCP server received the prompt: "${prompt}"`;

    return res.json({
      status: "success",
      response,
      sessionId,
    });
  }
  // Command: update_project_context
  else if (command === "update_project_context") {
    const { field, value } = body;

    if (!field || typeof value === "undefined") {
      return res.status(400).json({
        status: "error",
        message: "Missing 'field' or 'value'",
      });
    }

    const data = readData(dataFile);
    if (!data.project_context) {
      data.project_context = {};
    }

    data.project_context[field] = value;
    writeData(dataFile, data);

    if (sessionId) {
      sendUpdate(sessionId, "context_update", data);
    }

    return res.json({
      status: "success",
      project_context: data.project_context,
      sessionId,
    });
  }

  // Command: create_session
  else if (command === "create_session") {
    const newSessionId = createSession();
    return res.json({
      status: "success",
      sessionId: newSessionId,
      message: "Session created successfully",
    });
  }

  // If command is invalid
  return res.status(400).json({
    status: "error",
    message: `Unknown command: ${command}`,
  });
});

app.put("/project", (req, res) => {
  const sessionId = req.query.sessionId;
  const dataFile =
    sessionId && validateSession(sessionId)
      ? getSessionFile(sessionId)
      : DEFAULT_DATA_FILE;

  const currentData = readData(dataFile);
  const updatedData = {
    ...currentData,
    ...req.body,
  };

  writeData(dataFile, updatedData);

  if (sessionId) {
    sendUpdate(sessionId, "project_update", updatedData);
  }

  res.json({
    ...updatedData,
    sessionId,
  });
});

app.patch("/project/phase", (req, res) => {
  const sessionId = req.query.sessionId;
  const dataFile =
    sessionId && validateSession(sessionId)
      ? getSessionFile(sessionId)
      : DEFAULT_DATA_FILE;

  const currentData = readData(dataFile);
  currentData.phase = req.body.phase || currentData.phase;

  writeData(dataFile, currentData);

  if (sessionId) {
    sendUpdate(sessionId, "phase_update", currentData);
  }

  res.json({
    ...currentData,
    sessionId,
  });
});

app.patch("/project/task", (req, res) => {
  const sessionId = req.query.sessionId;
  const dataFile =
    sessionId && validateSession(sessionId)
      ? getSessionFile(sessionId)
      : DEFAULT_DATA_FILE;

  const currentData = readData(dataFile);
  currentData.current_task = req.body.current_task || currentData.current_task;

  writeData(dataFile, currentData);

  if (sessionId) {
    sendUpdate(sessionId, "task_update", currentData);
  }

  res.json({
    ...currentData,
    sessionId,
  });
});

app.patch("/project/context", (req, res) => {
  const sessionId = req.query.sessionId;
  const dataFile =
    sessionId && validateSession(sessionId)
      ? getSessionFile(sessionId)
      : DEFAULT_DATA_FILE;

  const currentData = readData(dataFile);
  currentData.project_context = {
    ...currentData.project_context,
    ...req.body,
  };

  writeData(dataFile, currentData);

  if (sessionId) {
    sendUpdate(sessionId, "context_update", currentData);
  }

  res.json({
    ...currentData,
    sessionId,
  });
});

// Health check endpoint REQUIRED by Copilot Agent
app.get("/initialize", (req, res) => {
  res.status(200).json({
    status: "ready",
    endpoints: {
      events: "/events",
      health: "/health",
      sessions: "/sessions",
    },
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  const sessionId = req.query.sessionId;
  let dataFile = DEFAULT_DATA_FILE;
  let sessionExists = false;

  if (sessionId) {
    sessionExists = validateSession(sessionId);
    if (sessionExists) {
      dataFile = getSessionFile(sessionId);
    }
  }

  try {
    // Check if we can access the relevant file
    fs.accessSync(dataFile, fs.constants.R_OK | fs.constants.W_OK);

    // Calculate total clients across all sessions
    let totalClients = 0;
    clients.forEach((sessionClients) => {
      totalClients += sessionClients.size;
    });

    res.status(200).json({
      status: "healthy",
      storage: "file",
      sessionId: sessionId || null,
      sessionValid: sessionId ? sessionExists : null,
      filePath: dataFile,
      dataStructure: readData(dataFile),
      connectedClients: {
        total: totalClients,
        forSession:
          sessionId && sessionExists ? clients.get(sessionId)?.size || 0 : null,
      },
      activeSessions: Object.keys(readSessions().sessions).length,
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: "Data file access error",
      sessionId: sessionId || null,
      sessionValid: sessionId ? sessionExists : null,
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`MCP Remote Server running on port ${PORT}`);
  console.log(`Session management is enabled`);
  console.log(`Main data file: ${DEFAULT_DATA_FILE}`);
  console.log(`Sessions data directory: ${DATA_DIR}`);
  console.log(`Initial project structure:`);
  console.log(readData());
  console.log(`SSE endpoint available at /events?sessionId=[YOUR_SESSION_ID]`);
});

module.exports = app;
