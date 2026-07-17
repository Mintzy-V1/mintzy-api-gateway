// First, add a new model for Transactions
// models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  upiTransactionId: {type :Number},
  amount: { type: Number, required: true }, // in USD
  credits: { type: Number, required: true },
  status: { type: String, required: true }, // e.g., 'pending', 'completed', 'failed'
  stripeSessionId: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);