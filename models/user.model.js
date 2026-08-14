import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
     googleId: {
    type: String,
    required: true,
    unique: true
  },

  name: {
    type: String,
    required: true
  },
  picture: {
    type: String,
    required: true
  },

  broker:{
        type:String,
        enum:["angle one","tradex","bear_street"],
        default:null
    },

    apiKey:{
        type:String,
        unique:true,
        sparse:true
    },


  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });


userSchema.index({ googleId: 1 });
userSchema.index({ email: 1 });


export default mongoose.model("User", userSchema);
