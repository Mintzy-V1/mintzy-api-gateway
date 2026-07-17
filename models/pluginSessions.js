const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model('pluginSessions', sessionSchema, 'sessions_collection');