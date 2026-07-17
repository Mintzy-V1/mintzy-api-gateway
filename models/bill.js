const mongoose = require('mongoose');

const billSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  accessTokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'accessToken' },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  type: { type: String, enum: ['token', 'credit_purchase'], default: 'token' },
  tokenName: { type: String },
  tokenPrefix: { type: String },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'plan' },
  planName: { type: String },
  amount: { type: Number, required: true, default: 0 },
  currency: { type: String, default: 'INR' },
  invoiceNumber: { type: String, required: true, unique: true },
  description: { type: String },
  status: { type: String, enum: ['generated', 'paid', 'cancelled'], default: 'generated' },
}, { timestamps: true });

module.exports = mongoose.model('Bill', billSchema);
