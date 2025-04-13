const net = require("net");
const http = require("http");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const url = require("url");
const fs = require("fs");
const path = require("path");

// Configure logging
const logger = {
  info: (message) =>
    console.log(`INFO: ${new Date().toISOString()} - ${message}`),
  error: (message) =>
    console.error(`ERROR: ${new Date().toISOString()} - ${message}`),
};

class Document {
  /**
   * Represents a document in the context store.
   */
  constructor(docId, content, metadata = {}) {
    this.docId = docId;
    this.content = content;
    this.metadata = metadata;
  }

  toDict() {
    return {
      doc_id: this.docId,
      content: this.content,
      metadata: this.metadata,
    };
  }
}

class ContextStore {
  /**
   * Manages document storage and retrieval.
   */
  constructor() {
    this.documents = {};
  }

  addDocument(content, metadata = {}) {
    /**
     * Add a document to the store and return its ID.
     */
    const docId = uuidv4();
    this.documents[docId] = new Document(docId, content, metadata);
    logger.info(`Added document with ID: ${docId}`);
    return docId;
  }

  getDocument(docId) {
    /**
     * Retrieve a document by its ID.
     */
    return this.documents[docId];
  }

  deleteDocument(docId) {
    /**
     * Delete a document by its ID.
     */
    if (docId in this.documents) {
      delete this.documents[docId];
      logger.info(`Deleted document with ID: ${docId}`);
      return true;
    }
    return false;
  }

  searchDocuments(query, topK = 5) {
    /**
     * Search for documents matching the query.
     * This is a simple implementation that checks for substring matches.
     * In a real implementation, you would use embeddings and vector search.
     */
    const results = [];
    const lowerQuery = query.toLowerCase();

    for (const docId in this.documents) {
      const doc = this.documents[docId];
      if (doc.content.toLowerCase().includes(lowerQuery)) {
        results.push(doc);
        if (results.length >= topK) {
          break;
        }
      }
    }

    return results;
  }
}

class Session {
  /**
   * Represents a user session with conversation history.
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.messages = [];
    this.contextDocs = []; // List of document IDs relevant to this session
    this.connectedClients = new Set(); // Store WebSocket connections for this session
  }

  addMessage(role, content) {
    /**
     * Add a message to the conversation history.
     */
    this.messages.push({ role, content });

    // Notify all connected clients about the new message
    this.notifyClients({
      type: "new_message",
      message: { role, content },
    });
  }

  getHistory() {
    /**
     * Get the conversation history.
     */
    return this.messages;
  }

  addContext(docId) {
    /**
     * Add a document to the context for this session.
     */
    if (!this.contextDocs.includes(docId)) {
      this.contextDocs.push(docId);

      // Notify clients about context update
      this.notifyClients({
        type: "context_updated",
        added_doc_id: docId,
      });
    }
  }

  removeContext(docId) {
    /**
     * Remove a document from the context for this session.
     */
    const index = this.contextDocs.indexOf(docId);
    if (index !== -1) {
      this.contextDocs.splice(index, 1);

      // Notify clients about context update
      this.notifyClients({
        type: "context_updated",
        removed_doc_id: docId,
      });
    }
  }

  addClient(websocket) {
    /**
     * Register a WebSocket client with this session.
     */
    this.connectedClients.add(websocket);
    logger.info(
      `Client connected to session ${this.sessionId}, total clients: ${this.connectedClients.size}`
    );

    // Send initial state to the new client
    websocket.send(
      JSON.stringify({
        type: "session_state",
        session_id: this.sessionId,
        messages: this.messages,
        context_docs: this.contextDocs,
      })
    );
  }

  removeClient(websocket) {
    /**
     * Remove a WebSocket client from this session.
     */
    this.connectedClients.delete(websocket);
    logger.info(
      `Client disconnected from session ${this.sessionId}, remaining clients: ${this.connectedClients.size}`
    );
  }

  notifyClients(message) {
    /**
     * Send a message to all connected WebSocket clients.
     */
    const messageStr = JSON.stringify(message);

    for (const client of this.connectedClients) {
      if (client.readyState === 1) {
        // OPEN
        client.send(messageStr);
      }
    }
  }

  toDict() {
    return {
      session_id: this.sessionId,
      messages: this.messages,
      context_docs: this.contextDocs,
      connected_clients: this.connectedClients.size,
    };
  }
}

class MCPServer {
  /**
   * Main server class that handles MCP requests.
   */
  constructor() {
    this.contextStore = new ContextStore();
    this.sessions = {};
  }

  getMCPFilePath() {
    return path.join(__dirname, "mcp.json");
  }

  loadProjectContextFromFile() {
    try {
      const data = fs.readFileSync(this.getMCPFilePath(), "utf8");
      const json = JSON.parse(data);
      return json.project_context || {};
    } catch (e) {
      logger.error("Failed to load mcp.json:", e.message);
      return {};
    }
  }

  saveProjectContextToFile(projectContext) {
    try {
      const mcpPath = this.getMCPFilePath();
      let mcpData = {};

      if (fs.existsSync(mcpPath)) {
        mcpData = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      }

      mcpData.project_context = projectContext;
      fs.writeFileSync(mcpPath, JSON.stringify(mcpData, null, 2), "utf8");
      logger.info("Saved updated project_context to mcp.json");
    } catch (e) {
      logger.error("Failed to write mcp.json:", e.message);
    }
  }

  createSession() {
    /**
     * Create a new session and return its ID.
     */
    const sessionId = uuidv4();
    this.sessions[sessionId] = new Session(sessionId);
    logger.info(`Created session with ID: ${sessionId}`);
    return sessionId;
  }

  getSession(sessionId) {
    /**
     * Get a session by its ID.
     */
    return this.sessions[sessionId];
  }

  deleteSession(sessionId) {
    /**
     * Delete a session by its ID.
     */
    if (sessionId in this.sessions) {
      // Close all WebSocket connections for this session
      const session = this.sessions[sessionId];
      session.notifyClients({
        type: "session_closed",
        session_id: sessionId,
      });

      for (const client of session.connectedClients) {
        client.close(1000, "Session closed");
      }

      delete this.sessions[sessionId];
      logger.info(`Deleted session with ID: ${sessionId}`);
      return true;
    }
    return false;
  }

  async handleRequest(requestData) {
    /**
     * Process incoming MCP requests.
     */
    try {
      const command = requestData.command;

      switch (command) {
        case "create_session": {
          const sessionId = this.createSession();
          return { status: "success", session_id: sessionId };
        }

        case "add_document": {
          const { content, metadata } = requestData;
          if (!content) {
            return { status: "error", message: "Content is required" };
          }

          const docId = this.contextStore.addDocument(content, metadata);
          return { status: "success", doc_id: docId };
        }

        case "get_document": {
          const { doc_id } = requestData;

          if (!doc_id) {
            return { status: "error", message: "Document ID is required" };
          }

          const document = this.contextStore.getDocument(doc_id);
          if (!document) {
            return { status: "error", message: "Document not found" };
          }

          return {
            status: "success",
            document: document.toDict(),
          };
        }

        case "delete_document": {
          const { doc_id } = requestData;

          if (!doc_id) {
            return { status: "error", message: "Document ID is required" };
          }

          const success = this.contextStore.deleteDocument(doc_id);
          if (!success) {
            return { status: "error", message: "Document not found" };
          }

          // Remove this document from any sessions that reference it
          for (const sessionId in this.sessions) {
            const session = this.sessions[sessionId];
            session.removeContext(doc_id);
          }

          return { status: "success" };
        }

        case "add_message": {
          const { session_id, role, content } = requestData;

          if (!session_id || !role || !content) {
            return { status: "error", message: "Missing required parameters" };
          }

          const session = this.getSession(session_id);
          if (!session) {
            return { status: "error", message: "Session not found" };
          }

          session.addMessage(role, content);
          return { status: "success" };
        }

        case "add_context": {
          const { session_id, doc_id } = requestData;

          if (!session_id || !doc_id) {
            return { status: "error", message: "Missing required parameters" };
          }

          const session = this.getSession(session_id);
          if (!session) {
            return { status: "error", message: "Session not found" };
          }

          const document = this.contextStore.getDocument(doc_id);
          if (!document) {
            return { status: "error", message: "Document not found" };
          }

          session.addContext(doc_id);
          return { status: "success" };
        }

        case "remove_context": {
          const { session_id, doc_id } = requestData;

          if (!session_id || !doc_id) {
            return { status: "error", message: "Missing required parameters" };
          }

          const session = this.getSession(session_id);
          if (!session) {
            return { status: "error", message: "Session not found" };
          }

          session.removeContext(doc_id);
          return { status: "success" };
        }

        case "get_context": {
          const { session_id } = requestData;

          if (!session_id) {
            return { status: "error", message: "Session ID is required" };
          }

          const session = this.getSession(session_id);
          if (!session) {
            return { status: "error", message: "Session not found" };
          }

          const contextDocuments = [];
          for (const docId of session.contextDocs) {
            const doc = this.contextStore.getDocument(docId);
            if (doc) {
              contextDocuments.push(doc.toDict());
            }
          }

          return {
            status: "success",
            context: contextDocuments,
          };
        }

        case "get_history": {
          const { session_id } = requestData;

          if (!session_id) {
            return { status: "error", message: "Session ID is required" };
          }

          const session = this.getSession(session_id);
          if (!session) {
            return { status: "error", message: "Session not found" };
          }

          return {
            status: "success",
            history: session.getHistory(),
          };
        }

        case "search": {
          const { query, top_k = 5 } = requestData;

          if (!query) {
            return { status: "error", message: "Query is required" };
          }

          const results = this.contextStore.searchDocuments(query, top_k);
          return {
            status: "success",
            results: results.map((doc) => doc.toDict()),
          };
        }

        case "update_project_context": {
          const { field, value } = requestData;

          if (!field || typeof value === "undefined") {
            return { status: "error", message: "Field and value are required" };
          }

          const projectContext = this.loadProjectContextFromFile();
          projectContext[field] = value;
          this.saveProjectContextToFile(projectContext);

          return {
            status: "success",
            project_context: projectContext,
          };
        }

        case "generate": {
          const { session_id, prompt } = requestData;

          if (!session_id || !prompt) {
            return { status: "error", message: "Missing required parameters" };
          }

          const session = this.getSession(session_id);
          if (!session) {
            return { status: "error", message: "Session not found" };
          }

          // In a real implementation, you would call an LLM API here
          // This is just a placeholder that echoes the prompt
          const response = `MCP Server received: ${prompt}`;

          // Add the user message and response to the conversation history
          session.addMessage("user", prompt);
          session.addMessage("assistant", response);

          return {
            status: "success",
            response,
          };
        }

        case "list_sessions": {
          const sessionsList = Object.keys(this.sessions).map((sessionId) => {
            const session = this.sessions[sessionId];
            return {
              session_id: sessionId,
              message_count: session.messages.length,
              context_docs_count: session.contextDocs.length,
              connected_clients: session.connectedClients.size,
            };
          });

          return {
            status: "success",
            sessions: sessionsList,
          };
        }

        default:
          return { status: "error", message: `Unknown command: ${command}` };
      }
    } catch (e) {
      logger.error(`Error processing request: ${e.message}`);
      return { status: "error", message: `Server error: ${e.message}` };
    }
  }

  handleWebSocketMessage(ws, sessionId, message) {
    /**
     * Handle messages from WebSocket clients.
     */
    try {
      const data = JSON.parse(message);

      // Add the session_id to the request if not present
      if (!data.session_id && sessionId) {
        data.session_id = sessionId;
      }

      // Process the command
      this.handleRequest(data).then((response) => {
        ws.send(JSON.stringify(response));
      });
    } catch (e) {
      logger.error(`Error processing WebSocket message: ${e.message}`);
      ws.send(
        JSON.stringify({
          status: "error",
          message: `Failed to process message: ${e.message}`,
        })
      );
    }
  }
}

class MCPServerProtocol {
  /**
   * Protocol handler for the MCP server.
   */
  constructor(server) {
    this.server = server;
  }

  async handleClient(socket) {
    /**
     * Handle a client connection.
     */
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info(`TCP client connected: ${addr}`);

    let buffer = Buffer.alloc(0);

    socket.on("data", async (data) => {
      buffer = Buffer.concat([buffer, data]);

      // Process complete messages
      while (buffer.length >= 4) {
        // Read the request size (first 4 bytes)
        const size = buffer.readUInt32BE(0);

        // If we don't have the complete message yet, wait for more data
        if (buffer.length < 4 + size) {
          break;
        }

        // Extract the message data
        const messageData = buffer.slice(4, 4 + size);

        // Remove the processed data from the buffer
        buffer = buffer.slice(4 + size);

        try {
          // Process the request
          const requestData = JSON.parse(messageData.toString());
          const responseData = await this.server.handleRequest(requestData);

          // Send the response
          const responseBytes = Buffer.from(JSON.stringify(responseData));
          const responseSize = Buffer.alloc(4);
          responseSize.writeUInt32BE(responseBytes.length);

          socket.write(Buffer.concat([responseSize, responseBytes]));

          logger.info(
            `Processed TCP request from ${addr}: ${requestData.command}`
          );
        } catch (e) {
          logger.error(`Error handling TCP client request: ${e.message}`);
        }
      }
    });

    socket.on("close", () => {
      logger.info(`TCP connection closed: ${addr}`);
    });

    socket.on("error", (err) => {
      logger.error(`TCP socket error for ${addr}: ${err.message}`);
    });
  }
}

async function startServer(config = {}) {
  /**
   * Start the MCP server with HTTP and WebSocket support.
   */
  const {
    host = "0.0.0.0",
    tcpPort = 8080,
    httpPort = process.env.PORT || 8081,
  } = config;


  const server = new MCPServer();
  const protocol = new MCPServerProtocol(server);

  // Start TCP server
  const tcpServer = net.createServer((socket) => {
    protocol.handleClient(socket);
  });

  tcpServer.listen(tcpPort, host, () => {
    logger.info(`MCP TCP server running on ${host}:${tcpPort}`);
  });

  // Create HTTP server that will also be used for WebSocket
  const httpServer = http.createServer(async (req, res) => {
    // Handle CORS for browser clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // Handle OPTIONS preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve a simple HTML page for WebSocket testing
    // Server-Sent Events (SSE) endpoint
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Send initial dummy event
      res.write(`event: message\n`);
       res.write(
         `data: ${JSON.stringify({ type: "initialized", status: "ok" })}\n\n`
       );

      // Ping every 10s to keep connection alive
      const interval = setInterval(() => {
        res.write(`event: ping\n`);
        res.write(`data: ${Date.now()}\n\n`);
      }, 10000);

      // Clean up if client closes connection
      req.on("close", () => {
        clearInterval(interval);
        res.end();
      });

      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>MCP Server WebSocket Test</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            #log { background: #f4f4f4; border: 1px solid #ddd; padding: 10px; height: 300px; overflow-y: auto; margin-bottom: 10px; }
            #message { width: 70%; padding: 5px; }
            button { padding: 5px 10px; }
            .container { margin-bottom: 20px; }
            h3 { margin-top: 20px; margin-bottom: 5px; }
          </style>
        </head>
        <body>
          <h1>MCP Server WebSocket Test</h1>
          
          <div class="container">
            <h3>Connection</h3>
            <div>
              <label for="sessionId">Session ID:</label>
              <input type="text" id="sessionId" placeholder="Leave empty to create new">
              <button onclick="connect()">Connect</button>
              <button onclick="disconnect()">Disconnect</button>
            </div>
          </div>
          
          <div class="container">
            <h3>Send Command</h3>
            <div>
              <textarea id="message" rows="4" cols="50" placeholder='{"command": "create_session"}'></textarea>
              <button onclick="sendMessage()">Send</button>
            </div>
          </div>
          
          <div class="container">
            <h3>Log</h3>
            <div id="log"></div>
            <button onclick="clearLog()">Clear Log</button>
          </div>
          
          <script>
            let ws;
            let currentSessionId = '';
            
            function appendToLog(message, isOutgoing = false) {
              const log = document.getElementById('log');
              const entry = document.createElement('div');
              entry.style.marginBottom = '5px';
              entry.style.color = isOutgoing ? 'blue' : 'green';
              entry.textContent = (isOutgoing ? '→ ' : '← ') + message;
              log.appendChild(entry);
              log.scrollTop = log.scrollHeight;
            }
            
            function clearLog() {
              document.getElementById('log').innerHTML = '';
            }
            
            function connect() {
              disconnect();
              
              const sessionInput = document.getElementById('sessionId');
              currentSessionId = sessionInput.value.trim();
              
              let wsUrl = 'ws://${host}:${httpPort}/ws';
              if (currentSessionId) {
                wsUrl += '?session_id=' + encodeURIComponent(currentSessionId);
              }
              
              ws = new WebSocket(wsUrl);
              
              ws.onopen = () => {
                appendToLog('WebSocket connection established');
                if (!currentSessionId) {
                  sendCommand('create_session');
                }
              };
              
              ws.onmessage = (event) => {
                const response = JSON.parse(event.data);
                appendToLog(JSON.stringify(response, null, 2));
                
                // If we created a session and got the ID back, update the field
                if (response.status === 'success' && response.session_id && !currentSessionId) {
                  currentSessionId = response.session_id;
                  document.getElementById('sessionId').value = currentSessionId;
                }
                
                // If we received the session state on connection
                if (response.type === 'session_state') {
                  currentSessionId = response.session_id;
                  document.getElementById('sessionId').value = currentSessionId;
                }
              };
              
              ws.onclose = () => {
                appendToLog('WebSocket connection closed');
              };
              
              ws.onerror = (error) => {
                appendToLog('WebSocket error: ' + error.message);
              };
            }
            
            function disconnect() {
              if (ws) {
                ws.close();
                ws = null;
              }
            }
            
            function sendMessage() {
              if (!ws || ws.readyState !== WebSocket.OPEN) {
                appendToLog('WebSocket is not connected', true);
                return;
              }
              
              const messageInput = document.getElementById('message');
              const message = messageInput.value.trim();
              
              if (message) {
                try {
                  // Try to parse as JSON
                  const jsonMessage = JSON.parse(message);
                  
                  // Add session_id if not present
                  if (!jsonMessage.session_id && currentSessionId) {
                    jsonMessage.session_id = currentSessionId;
                  }
                  
                  const finalMessage = JSON.stringify(jsonMessage);
                  ws.send(finalMessage);
                  appendToLog(finalMessage, true);
                } catch (e) {
                  appendToLog('Invalid JSON: ' + e.message, true);
                }
              }
            }
            
            function sendCommand(command, params = {}) {
              if (!ws || ws.readyState !== WebSocket.OPEN) {
                appendToLog('WebSocket is not connected', true);
                return;
              }
              
              const message = { command, ...params };
              if (currentSessionId && !message.session_id) {
                message.session_id = currentSessionId;
              }
              
              const jsonMessage = JSON.stringify(message);
              ws.send(jsonMessage);
              appendToLog(jsonMessage, true);
            }
          </script>
        </body>
        </html>
      `);
      return;
    }

    // Handle API requests
    if (req.method === "POST") {
      try {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString();
        const requestData = JSON.parse(body);

        const responseData = await server.handleRequest(requestData);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseData));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: e.message }));
      }
    } else {
      // Method not allowed for API endpoints other than GET / and POST
      if (req.url !== "/") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ status: "error", message: "Method not allowed" })
        );
      }
    }
  });

  // Create WebSocket server attached to the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket connections
  httpServer.on("upgrade", (request, socket, head) => {
    // Extract session ID from URL query parameters if provided
    const parsedUrl = url.parse(request.url, true);
    const pathname = parsedUrl.pathname;

    // Only handle WebSocket connections to /ws path
    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const sessionId = parsedUrl.query.session_id;

        logger.info(
          `WebSocket client connected${
            sessionId ? ` to session ${sessionId}` : ""
          }`
        );

        // If a session ID was provided, try to use it
        if (sessionId) {
          const session = server.getSession(sessionId);
          if (session) {
            // Register this WebSocket with the session
            session.addClient(ws);

            // Set up cleanup on connection close
            ws.on("close", () => {
              session.removeClient(ws);
            });
          } else {
            // Session not found
            ws.send(
              JSON.stringify({
                status: "error",
                message: `Session not found: ${sessionId}`,
              })
            );
            ws.close(1011, "Session not found");
            return;
          }
        }

        // Handle incoming WebSocket messages
        ws.on("message", (message) => {
          server.handleWebSocketMessage(ws, sessionId, message.toString());
        });

        // Handle WebSocket errors
        ws.on("error", (err) => {
          logger.error(`WebSocket error: ${err.message}`);
        });
      });
    } else {
      socket.destroy();
    }
  });

  // Start the HTTP/WebSocket server
  httpServer.listen(httpPort, host, () => {
    logger.info(`MCP HTTP/WebSocket server running on ${host}:${httpPort}`);
    logger.info(`WebSocket endpoint: ws://${host}:${httpPort}/ws`);
    logger.info(`HTML test page: http://${host}:${httpPort}/`);
  });

  return { tcpServer, httpServer, wss };
}

// Start the server if this script is run directly
if (require.main === module) {
  startServer().catch((err) => {
    logger.error(`Server error: ${err.message}`);
    process.exit(1);
  });
}

// Export for use as a module
module.exports = {
  Document,
  ContextStore,
  Session,
  MCPServer,
  MCPServerProtocol,
  startServer,
};
