const { sendJSON, sendError } = require('../utils/response');
const supabase = require('../db/supabase');
const fs = require('fs');
const path = require('path');

async function handleMediaUpload(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return sendError(res, 400, 'No file provided in body');
      }

      const fileExtension = req.headers['x-file-extension'] || 'bin';
      const fileName = `${req.user.userId}-${Date.now()}.${fileExtension}`;
      const filePath = path.join('/tmp', fileName); 

      // Save locally to stream up
      fs.writeFileSync(filePath, buffer);
      
      const fileBufferForUpload = fs.readFileSync(filePath);
      const { data, error } = await supabase.storage
        .from('media') // Assume 'media' bucket exists
        .upload(fileName, fileBufferForUpload, {
          contentType: req.headers['content-type'] || 'application/octet-stream',
          upsert: true
        });

      if (error) {
        fs.unlinkSync(filePath);
        return sendError(res, 500, error.message);
      }

      fs.unlinkSync(filePath);

      const { data: urlData } = supabase.storage.from('media').getPublicUrl(fileName);
      sendJSON(res, 200, { url: urlData.publicUrl });
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
