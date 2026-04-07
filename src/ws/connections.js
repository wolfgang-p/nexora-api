// Map of userId -> Set of WebSockets
const connections = new Map();

function addConnection(userId, ws) {
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }
  connections.get(userId).add(ws);
}

function removeConnection(userId, ws) {
  const userConnections = connections.get(userId);
  if (userConnections) {
    userConnections.delete(ws);
    if (userConnections.size === 0) {
      connections.delete(userId);
    }
  }
}

// Returns a Set of WebSockets (or empty Set)
function getConnections(userId) {
  return connections.get(userId) || new Set();
}

module.exports = {
  connections,
  addConnection,
  removeConnection,
  getConnections
};
