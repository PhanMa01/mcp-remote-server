const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "mcp.json");

// Store connected SSE clients
const clients = new Set();

// Initialize data file with default structure if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(
    DATA_FILE,
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
app.use(bodyParser.json());

// Helper functions for file operations
const readData = () => {
  try {
    const rawData = fs.readFileSync(DATA_FILE);
    return JSON.parse(rawData);
  } catch (error) {
    console.error("Error reading data file:", error);
    return {
      project_name: "Untitled",
      phase: "init",
      current_task: "",
      project_context: {},
    };
  }
};

const writeData = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error writing data file:", error);
  }
};

// Send SSE updates to all connected clients
const sendUpdate = (eventType, data) => {
  const eventData = JSON.stringify(data);
  clients.forEach(client => {
    client.write(`event: ${eventType}\n`);
    client.write(`data: ${eventData}\n\n`);
  });
};

// SSE endpoint for clients to subscribe
app.get("/events", (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial data
  const data = readData();
  
  // Gửi event 'initialized' để Copilot Agent hoàn tất kết nối
  res.write(`event: message\n`);
  res.write(
    `data: ${JSON.stringify({ type: "initialized", status: "ok" })}\n\n`
  );

  res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${Date.now()}\n\n`);
  }, 10000);

  // Add client to the set
  clients.add(res);

  // Remove client when connection is closed
  req.on("close", () => {
    clients.delete(res);
    console.log("Client disconnected, total connected:", clients.size);
  });

  console.log("New client connected, total connected:", clients.size);
});

// API Endpoints
app.get("/project", (req, res) => {
  const data = readData();
  res.json(data);
});

app.put("/project", (req, res) => {
  const currentData = readData();
  const updatedData = {
    ...currentData,
    ...req.body,
  };

  writeData(updatedData);
  sendUpdate("project_update", updatedData);
  res.json(updatedData);
});

app.patch("/project/phase", (req, res) => {
  const currentData = readData();
  currentData.phase = req.body.phase || currentData.phase;

  writeData(currentData);
  sendUpdate("phase_update", currentData);
  res.json(currentData);
});

app.patch("/project/task", (req, res) => {
  const currentData = readData();
  currentData.current_task = req.body.current_task || currentData.current_task;

  writeData(currentData);
  sendUpdate("task_update", currentData);
  res.json(currentData);
});

app.patch("/project/context", (req, res) => {
  const currentData = readData();
  currentData.project_context = {
    ...currentData.project_context,
    ...req.body,
  };

  writeData(currentData);
  sendUpdate("context_update", currentData);
  res.json(currentData);
});

// Health check endpoint
app.get("/health", (req, res) => {
  try {
    fs.accessSync(DATA_FILE, fs.constants.R_OK | fs.constants.W_OK);
    res.status(200).json({
      status: "healthy",
      storage: "file",
      filePath: DATA_FILE,
      dataStructure: readData(),
      connectedClients: clients.size
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: "Data file access error",
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`MCP Remote Server running on port ${PORT}`);
  console.log(`Project data is being stored in: ${DATA_FILE}`);
  console.log(`Initial project structure:`);
  console.log(readData());
  console.log(`SSE endpoint available at /events`);
});

module.exports = app;
