'use strict';

const os = require('os');
const port = Number(process.env.PORT || 3000);
const urls = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const item of list || []) {
    if (item.family === 'IPv4' && !item.internal && item.address) {
      urls.push(`http://${item.address}:${port}`);
    }
  }
}
console.log('Open on this PC:');
console.log(`  http://localhost:${port}`);
console.log('');
if (urls.length) {
  console.log('Try from iPhone on the same Wi-Fi:');
  for (const url of Array.from(new Set(urls))) console.log(`  ${url}`);
} else {
  console.log('No LAN IPv4 address was detected. Check your Wi-Fi/LAN connection.');
}
console.log('');
console.log('If you use a temporary tunnel, set PUBLIC_BASE_URL before npm start.');
