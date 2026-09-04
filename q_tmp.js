const mongoose = require('mongoose');
(async () => {
  await mongoose.connect('mongodb+srv://mintzy01ai_db_user:zTqQRkovgKbLXQdp@cluster0.cztcxpr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0');
  const db = mongoose.connection.useDb('mintzy_plugin');
  const c = db.db.collection('plugin_sessions');
  const docs = await c.find({"python_session_id":"session_20260803060931_d3f25722"}).toArray();
  console.log('plugin_sessions count=', docs.length);
  docs.forEach(d => console.log(JSON.stringify(d, null, 1).slice(0,1800)));
  await mongoose.disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
