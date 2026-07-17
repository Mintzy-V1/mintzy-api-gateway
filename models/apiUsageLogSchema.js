// models/ApiUsageLog.js

const mongoose = require('mongoose');

const apiUsageLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'AccessToken', required: true },
  endpoint: { type: String, required: true },
  method: { type: String, required: true },
  statusCode: { type: Number, required: true },
  creditsUsed: { type: Number, default: 1 },
  ipAddress: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now }
});

apiUsageLogSchema.index({ userId: 1, createdAt: -1 });
module.exports = mongoose.model('ApiUsageLog', apiUsageLogSchema);