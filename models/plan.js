// models/Plan.js
import mongoose from "mongoose";

const planSchema = new mongoose.Schema({
  name: { type: String, required: true },
  credits: { type: Number, required: true },
  price: { type: Number, required: true },
  features: [String],
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.plan || mongoose.model("plan", planSchema);
