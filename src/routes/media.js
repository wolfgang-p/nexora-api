const { sendJSON, sendError } = require('../utils/response');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Public directory at project root: <repo>/public/images|audio|videos|files/
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function getSubdir(ext) {
  const images = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'];
  const audio = ['m4a', 'mp3', 'aac', 'ogg', 'wav', 'opus'];
  const videos = ['mp4', 'mov', 'avi', 'webm', 'mkv'];
  if (images.includes(ext)) return 'images';
  if (audio.includes(ext)) return 'audio';
  if (videos.includes(ext)) return 'videos';
  return 'files';
}

async function handleMediaUpload(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return sendError(res, 400, 'No file provided in body');
      }

      const ext = (req.headers['x-file-extension'] || 'bin').toLowerCase();
      const subdir = getSubdir(ext);
      const fileName = `${crypto.randomUUID()}.${ext}`;
      const targetDir = path.join(PUBLIC_DIR, subdir);
      const filePath = path.join(targetDir, fileName);

      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(filePath, buffer);

      // Build public URL using host from request
      const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost:3001';
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const url = `${protocol}://${host}/public/${subdir}/${fileName}`;

      sendJSON(res, 200, { url });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  req.on('error', (err) => {
    sendError(res, 500, err.message);
  });
}

module.exports = {
  handleMediaUpload
};
