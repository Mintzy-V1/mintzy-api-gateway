// models/AccessToken.js

const mongoose = require('mongoose');
const accessTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true, unique: true }, // Hashed
  tokenPrefix: { type: String, required: true },
  name: String,
  lastUsedAt: Date,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

accessTokenSchema.index({ token: 1 });
module.exports = mongoose.model('accessToken', accessTokenSchema);