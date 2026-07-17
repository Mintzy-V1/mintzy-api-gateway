import mongoose from "mongoose";

const tradingSessionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  python_session_id: { type: String },
  status: { type: String, default: 'created' },
  vm_url: { type: String },
  auto_auth_on_credentials: { type: Boolean, default: false },
  saved_configuration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SavedTradingConfiguration' },
  configuration_name: { type: String, trim: true },
  trading_configuration: { type: mongoose.Schema.Types.Mixed },
  created_at: { type: Date, default: Date.now },
  ended_at: { type: Date }
});

export default mongoose.models.TradingSession || mongoose.model("TradingSession", tradingSessionSchema);
