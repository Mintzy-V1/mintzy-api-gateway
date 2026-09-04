import mongoose from "mongoose";

const performanceStatSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  broker: { type: String, enum: ['angle_one', 'tradex', 'bear_street'] },
  as_of_date: { type: String },
  stats: { type: mongoose.Schema.Types.Mixed },
  computed_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

export default mongoose.models.PerformanceStat || mongoose.model("PerformanceStat", performanceStatSchema);