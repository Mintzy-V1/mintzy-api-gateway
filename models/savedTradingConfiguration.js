import mongoose from "mongoose";

const savedTradingConfigurationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, trim: true, maxlength: 500 },
  configuration: { type: mongoose.Schema.Types.Mixed, required: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

export default mongoose.models.SavedTradingConfiguration || mongoose.model("SavedTradingConfiguration", savedTradingConfigurationSchema);
