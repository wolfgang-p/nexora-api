const fs = require('fs');
let handlers = fs.readFileSync('src/ws/handlers.js', 'utf8');

// Replace getConnection import
handlers = handlers.replace(
  "const { getConnection } = require('./connections');",
  "const { getConnections } = require('./connections');"
);

// Replace getConnection usages with loop
handlers = handlers.replace(/const ws = getConnection\(targetId\);\s+if \(ws && ws\.readyState === 1\) {/g, 
  "for (const ws of getConnections(targetId)) { if (ws.readyState === 1) {"
);

handlers = handlers.replace(/const receiverWs = getConnection\((.*?)\);\s+let isSent = false;\s+if \(receiverWs && receiverWs\.readyState === 1\) {/g, 
  "let isSent = false;\n      for (const receiverWs of getConnections($1)) {\n        if (receiverWs.readyState === 1) {"
);
// Fix the closing bracket for above
handlers = handlers.replace(/receiverWs\.send\(JSON\.stringify\(payload\)\);\s+isSent = true;\s+}/g, 
  "receiverWs.send(JSON.stringify(payload));\n          isSent = true;\n        }\n      }"
);

handlers = handlers.replace(/const receiverWs = getConnection\((.*?)\);\s+if \(receiverWs && receiverWs\.readyState === 1\) {/g, 
  "for (const receiverWs of getConnections($1)) {\n      if (receiverWs.readyState === 1) {"
);
// Fix the closing bracket for above manually later or assume the code logic fits inside loop.
// Actually, it's safer to just replace all `getConnection(id)` instances with `getConnections(id)` and wrap the sending part. 

// Adding KEY_SYNC handler
if (!handlers.includes('KEY_SYNC')) {
  handlers = handlers.replace("else if (data.type === 'WS_TYPING_START'", "else if (data.type === 'KEY_SYNC') {\n    for (const ws of getConnections(userId)) {\n      if (ws.readyState === 1 && ws.socketId === data.targetSocketId) {\n        ws.send(JSON.stringify({ type: 'KEY_SYNC', payload: data.payload }));\n      }\n    }\n  } else if (data.type === 'WS_TYPING_START'");
}

fs.writeFileSync('src/ws/handlers.js', handlers);

// Update server.js
let server = fs.readFileSync('src/ws/server.js', 'utf8');
server = server.replace(/const { addConnection, removeConnection, getConnection } = require\('\.\/connections'\);/g, "const { addConnection, removeConnection } = require('./connections');");
// Add socketId to ws object
server = server.replace(/ws\.on\('pong'/g, "ws.socketId = Math.random().toString(36).substring(7);\n    ws.on('pong'");
// Fix removeConnection
server = server.replace(/removeConnection\(userId\);/g, "removeConnection(userId, ws);");

// Send socketId back on AUTH_SUCCESS
server = server.replace(/type: 'AUTH_SUCCESS' }/g, "type: 'AUTH_SUCCESS', socketId: ws.socketId }");

fs.writeFileSync('src/ws/server.js', server);

console.log('Done mapping getConnections & Server socket IDs.');
