// Map of userId -> WebSocket client
const connections = new Map();

function addConnection(userId, ws) {
  connections.set(userId, ws);
}

function removeConnection(userId) {
  connections.delete(userId);
}

function getConnection(userId) {
  return connections.get(userId);
}

module.exports = {
  connections,
  addConnection,
  removeConnection,
  getConnection
};
