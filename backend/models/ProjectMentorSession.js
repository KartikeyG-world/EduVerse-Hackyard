const mongoose = require('mongoose');

const mentorMessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },
  content: {
    type: String,
    required: true
  },
  recommendedResource: {
    title: { type: String, default: null },
    url: { type: String, default: null },
    type: { type: String, default: 'none' },
    skillId: { type: String, default: null },
    destination: { type: String, default: null },
    label: { type: String, default: null }
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const projectMentorSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  progressId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserBuildProgress',
    required: true,
    index: true
  },
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BuildPathTemplate',
    required: true
  },
  moduleIndex: {
    type: Number,
    required: true
  },
  agent37SessionId: {
    type: String,
    default: null
  },
  messages: [mentorMessageSchema]
}, { timestamps: true });

// Scoped compound index ensures one mentor session per learner per milestone
projectMentorSessionSchema.index({ userId: 1, progressId: 1, moduleIndex: 1 }, { unique: true });

module.exports = mongoose.model('ProjectMentorSession', projectMentorSessionSchema);
