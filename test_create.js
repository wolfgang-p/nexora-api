require('dotenv').config();
const { signJWT } = require('./src/crypto');

// Generate test token for User: 0adc552a-554a-49a9-a15a-753e668ad60d
const reqUser = {
  userId: '0adc552a-554a-49a9-a15a-753e668ad60d',
  phone: '123',
  accountType: 'personal'
};

const token = signJWT(reqUser);
console.log('Test Token:', token);

async function boot() {
  const res = await fetch('http://localhost:3001/workspaces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ name: 'Fetch API Test', description: '' })
  });

  const txt = await res.text();
  console.log('Status:', res.status);
  console.log('Response:', txt);
}
boot();
