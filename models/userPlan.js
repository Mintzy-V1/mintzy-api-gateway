// models/UserPlan.js
import mongoose from "mongoose";
const userPlanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'plan', required: true },
  creditsRemaining: { type: Number, required: true },
  isActive: { type: Boolean, default: true },
  expiresAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.models.UserPlan || mongoose.model("UserPlan", userPlanSchema);
