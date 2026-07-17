const mongoose = require('mongoose');

const waitlistSchema = new mongoose.Schema({
  email: {
    type: String,   
    required: true,       // email must be provided
    unique: true,         // no duplicate emails allowed
    lowercase: true,      // converts input to lowercase automatically
    trim: true,           // removes spaces before/after
    match: [/.+\@.+\..+/, 'Please fill a valid email address'] // regex validation
  },
  joinedAt: {
    type: Date,
    default: Date.now     // auto set join time
  }
});

const Waitlist = mongoose.model('Waitlist', waitlistSchema);
module.exports = Waitlist;
