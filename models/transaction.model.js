const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  credits: { type: Number, required: true },
  amount: { type: Number },
  currency: { type: String, default: 'INR' },
  paymentMethod: { type: String, enum: ['razorpay', 'upi'], default: 'razorpay' },
  upitxnId: { type: String },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  status: {
    type: String,
    enum: ['initiated', 'pending_approval', 'approved', 'rejected', 'failed'],
    default: 'initiated',
  },
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
