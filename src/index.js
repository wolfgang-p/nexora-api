require('dotenv').config();
const http = require('http');
const { routeRequest } = require('./router');
const { setupWebSocketServer } = require('./ws/server');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  routeRequest(req, res);
});

setupWebSocketServer(server);

server.listen(PORT, () => {
  console.log(`Nexora backend is running on http://localhost:${PORT}`);
});
