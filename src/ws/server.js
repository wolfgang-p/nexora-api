const WebSocket = require('ws');
const { verifyJWT } = require('../crypto/index');
const { addConnection, removeConnection, getConnection } = require('./connections');
const { handleMessage } = require('./handlers');
const supabase = require('../db/supabase');

function setupWebSocketServer(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    // Basic WebSocket upgrader logic
    if (request.url.startsWith('/ws')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    let userId = null;
    let isAlive = true;

    ws.on('pong', () => { isAlive = true; });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        
        if (data.type === 'AUTH') {
          const payload = verifyJWT(data.token);
          if (payload && payload.userId) {
            userId = payload.userId;
            addConnection(userId, ws);
            // Mark online in DB
            await supabase.from('users').update({ is_online: true }).eq('id', userId);
            
            // Assign a unique session ID and send it back
            ws.sessionId = Math.random().toString(36).substring(2, 15);
            ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', sessionId: ws.sessionId }));
          } else {
            ws.send(JSON.stringify({ type: 'AUTH_FAILED' }));
            ws.close();
          }
          return;
        }

        if (data.type === 'KEY_SYNC') {
            wss.clients.forEach(client => {
                if (client.sessionId === data.targetSocketId && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'KEY_SYNC', payload: data.payload }));
                }
            });
            return;
        }

        if (!userId) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Not authenticated' }));
          return;
        }

        await handleMessage(userId, data, ws);

      } catch (err) {
        console.error('WS MSG Error:', err);
      }
    });

    ws.on('close', async () => {
      if (userId) {
        removeConnection(userId);
        await supabase.from('users').update({ is_online: false, last_seen: new Date() }).eq('id', userId);
      }
    });

    // Handle initial timeout for AUTH
    setTimeout(() => {
      if (!userId && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, 5000); // 5 sec to send AUTH
  });

  // Ping intervals to detect dead connections
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  return wss;
}

module.exports = { setupWebSocketServer };
