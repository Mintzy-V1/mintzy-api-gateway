const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["human", "ai"], // sender type
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const sessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true, // ensures no duplicate session IDs
      index: true,
    },
    email: {
      type: String,
      required: true,
      index: true,
    },
    messages: [messageSchema],
  },
  { timestamps: true } // adds createdAt & updatedAt
);

const Session = mongoose.model("Session", sessionSchema);

module.exports = Session;
