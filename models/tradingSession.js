import mongoose from "mongoose";

const tradingSessionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  python_session_id: { type: String },
  broker: { type: String, enum: ['angle_one', 'tradex', 'bear_street', 'firstock'], index: true },
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
    // Mongoose validates every DB-hydrated path on save(), not just modified ones,
    // so any value written at runtime must be listed here or the next save() throws.
    enum: [
      'pending', 'running', 'started', 'completed', 'failed',
      'handoff_in_progress', 'handoff_failed', 'cancelling', 'cancelled',
      'live_start_pending', 'live_start_in_progress', 'stop_failed_vm_unavailable',
      // No longer written, but ~62 documents from Aug 2026 still carry it.
      'stopped'
    ],
    default: undefined
  },
  simulation_started_at: { type: Date },
  simulation_completed_at: { type: Date },
  simulation_cancel_requested: { type: Boolean, default: false },
  simulation_live_switch_triggered: { type: Boolean, default: false },
  simulation_live_started_at: { type: Date },
  live_start_claimed_at: { type: Date },
  simulation_trade_date: { type: String },
  simulation_output: { type: mongoose.Schema.Types.Mixed },
  scheduled_start: {
    payload: { type: mongoose.Schema.Types.Mixed },
    start_at: { type: Date },
    trade_date: { type: String },
    status: { type: String, enum: ['pending', 'firing', 'fired', 'failed', 'cancelled'] },
    attempts: { type: Number, default: 0 },
    error: { type: String },
    created_at: { type: Date },
    firing_at: { type: Date },
    fired_at: { type: Date }
  }
});

export default mongoose.models.TradingSession || mongoose.model("TradingSession", tradingSessionSchema);
