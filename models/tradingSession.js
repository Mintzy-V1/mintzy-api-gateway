import mongoose from "mongoose";

const tradingSessionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  python_session_id: { type: String },
  broker: { type: String, enum: ['angle_one', 'tradex', 'bear_street'], index: true },
  status: { type: String, default: 'created' },
  vm_url: { type: String },
  auto_auth_on_credentials: { type: Boolean, default: false },
  credentials_fingerprint: { type: String },
  saved_configuration_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SavedTradingConfiguration' },
  configuration_name: { type: String, trim: true },
  trading_configuration: { type: mongoose.Schema.Types.Mixed },
  created_at: { type: Date, default: Date.now },
  ended_at: { type: Date },
  simulation_job_id: { type: String },
  simulation_status: {
    type: String,
    enum: ['pending', 'running', 'started', 'completed', 'failed', 'handoff_in_progress'],
    default: undefined
  },
  simulation_started_at: { type: Date },
  simulation_completed_at: { type: Date },
  simulation_live_switch_triggered: { type: Boolean, default: false },
  simulation_live_started_at: { type: Date },
  simulation_trade_date: { type: String },
  simulation_output: { type: mongoose.Schema.Types.Mixed }
});

export default mongoose.models.TradingSession || mongoose.model("TradingSession", tradingSessionSchema);
