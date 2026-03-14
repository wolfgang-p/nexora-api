const sendJSON = (res, statusCode, data) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const sendError = (res, statusCode, message) => {
  sendJSON(res, statusCode, { error: message });
};

module.exports = { sendJSON, sendError };
