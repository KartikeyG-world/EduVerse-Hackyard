const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const BuildPathTemplate = require('../models/BuildPathTemplate');
const UserBuildProgress = require('../models/UserBuildProgress');
const Problem = require('../models/Problem');
const Skill = require('../models/Skill');
const ProjectMentorSession = require('../models/ProjectMentorSession');
const { protect, optionalAuth } = require('../middlewares/auth');
const {
  findMatchingTemplate,
  generateBuildPathTemplate,
  evaluateTaskSubmission,
  generateModuleStepByStepGuide
} = require('../services/buildPathService');
const {
  isAgent37Configured,
  buildMentorInput,
  matchRecommendedResource,
  callAgent37MessagingAPI
} = require('../services/agent37Service');
const { awardUserXp } = require('../utils/gamification');

const mentorRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many mentor requests. Please wait a few moments before asking again.'
  }
});

// Feature Flag Guard
const isBuildPathEnabled = () => {
  return process.env.FEATURE_PROJECT_BUILD_PATH === 'true';
};

const gateFeature = (req, res, next) => {
  if (!isBuildPathEnabled()) {
    return res.status(403).json({
      success: false,
      message: 'Project Build Path feature is currently disabled',
      featureDisabled: true
    });
  }
  next();
};

router.use(gateFeature);

// @route   POST /api/build-paths/generate
// @desc    Intake flow: matches canonical template or generates new 3-layer curriculum
router.post('/generate', protect, async (req, res) => {
  try {
    const { projectIdea, techStack, skillLevel, platform } = req.body;

    if (!projectIdea || typeof projectIdea !== 'string' || projectIdea.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: 'A clear project description or goal is required (minimum 3 characters).'
      });
    }

    const intake = {
      projectIdea: projectIdea.trim(),
      techStack: Array.isArray(techStack) ? techStack : (typeof techStack === 'string' ? [techStack] : []),
      skillLevel: ['beginner', 'intermediate', 'advanced'].includes((skillLevel || '').toLowerCase())
        ? skillLevel.toLowerCase()
        : 'beginner',
      platform: ['web', 'mobile', 'desktop', 'fullstack', 'any'].includes((platform || '').toLowerCase())
        ? platform.toLowerCase()
        : 'web'
    };

    // Step 1: Check canonical signature & template reuse
    const match = await findMatchingTemplate(intake);
    let template;
    let isReused = false;

    if (match && match.template) {
      template = match.template;
      template.usageCount = (template.usageCount || 1) + 1;
      await template.save();
      isReused = true;
      console.info(`[BuildPaths] Reusing cached template for "${intake.projectIdea}" (Signature: ${template.canonicalSignature})`);
    } else {
      console.info(`[BuildPaths] Generating new 3-layer template for "${intake.projectIdea}"...`);
      template = await generateBuildPathTemplate(intake);
    }

    // Step 2: Initialize or fetch user progress
    let progress = await UserBuildProgress.findOne({
      userId: req.user.id,
      templateId: template._id
    });

    if (!progress) {
      progress = await UserBuildProgress.create({
        userId: req.user.id,
        templateId: template._id,
        status: 'active',
        currentModuleIndex: 0,
        completedModules: [],
        totalXpEarned: 0
      });
    }

    res.status(200).json({
      success: true,
      isReused,
      template,
      progress
    });
  } catch (err) {
    console.error('[BuildPaths:Generate Error]:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to generate build path. Please try again.'
    });
  }
});

// @route   GET /api/build-paths/templates
// @desc    List popular build path templates for exploration
router.get('/templates', optionalAuth, async (req, res) => {
  try {
    const templates = await BuildPathTemplate.find({})
      .select('canonicalSignature projectIdea normalizedTitle overview techStack skillLevel platform usageCount qualityScore modules.title')
      .sort({ usageCount: -1, createdAt: -1 })
      .limit(30)
      .lean();

    res.json({ success: true, templates });
  } catch (err) {
    console.error('[BuildPaths:ListTemplates Error]:', err);
    res.status(500).json({ success: false, message: 'Server error listing templates' });
  }
});

// @route   GET /api/build-paths/templates/:id
// @desc    Get full template details
router.get('/templates/:id', optionalAuth, async (req, res) => {
  try {
    const template = await BuildPathTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Build path template not found' });
    }
    res.json({ success: true, template });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching template' });
  }
});

// @route   GET /api/build-paths/templates/:id/modules/:moduleIndex/guide
// @desc    Get or generate cached step-by-step guide for a specific milestone.
// NOTE: protect (not optionalAuth) is deliberate — on cache-miss this route calls the AI gateway
//       and permanently caches the result on the shared BuildPathTemplate document (real AI spend).
//       Unauthenticated requests are rejected here consistent with all other AI-triggering routes
//       in this project (POST /generate, POST /submit, POST /ai/* etc.).
router.get('/templates/:id/modules/:moduleIndex/guide', protect, async (req, res) => {
  try {
    const template = await BuildPathTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const moduleIndex = parseInt(req.params.moduleIndex, 10);
    const targetModule = template.modules.find((m) => m.moduleIndex === moduleIndex);
    if (!targetModule) {
      return res.status(404).json({ success: false, message: 'Module not found in template' });
    }

    // Return cached guide if already generated on the template
    if (Array.isArray(targetModule.stepByStepGuide) && targetModule.stepByStepGuide.length > 0) {
      return res.json({
        success: true,
        source: 'cache',
        stepByStepGuide: targetModule.stepByStepGuide
      });
    }

    // Otherwise generate on-demand, cache onto template, and return
    const guide = await generateModuleStepByStepGuide(template.projectIdea, template.techStack, targetModule);
    targetModule.stepByStepGuide = guide;
    await template.save();

    res.json({
      success: true,
      source: 'generated',
      stepByStepGuide: guide
    });
  } catch (err) {
    console.error('[BuildPaths:Guide Error]:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve step-by-step guide' });
  }
});

// @route   GET /api/build-paths/progress
// @desc    Get all active build paths for the authenticated user
router.get('/progress', protect, async (req, res) => {
  try {
    const list = await UserBuildProgress.find({ userId: req.user.id })
      .populate('templateId')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ success: true, progressList: list });
  } catch (err) {
    console.error('[BuildPaths:GetProgress Error]:', err);
    res.status(500).json({ success: false, message: 'Server error fetching user progress' });
  }
});

// @route   GET /api/build-paths/progress/:id
// @desc    Get user's progress for a specific build path (with ownership check)
router.get('/progress/:id', protect, async (req, res) => {
  try {
    const progress = await UserBuildProgress.findById(req.params.id).populate('templateId');
    if (!progress) {
      return res.status(404).json({ success: false, message: 'Progress record not found' });
    }

    // Strict ownership check
    if (progress.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this progress record' });
    }

    res.json({ success: true, progress });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching progress' });
  }
});

// @route   POST /api/build-paths/progress/:id/modules/:moduleIndex/submit
// @desc    Submit deliverable for a hands-on task with optional AI feedback
router.post('/progress/:id/modules/:moduleIndex/submit', protect, async (req, res) => {
  try {
    const { submissionType = 'text', content, requestAiFeedback = true } = req.body;
    const moduleIdx = parseInt(req.params.moduleIndex, 10);

    const progress = await UserBuildProgress.findById(req.params.id).populate('templateId');
    if (!progress) {
      return res.status(404).json({ success: false, message: 'Progress record not found' });
    }

    if (progress.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to modify this progress record' });
    }

    const template = progress.templateId;
    const targetModule = template.modules?.find((m) => m.moduleIndex === moduleIdx);
    if (!targetModule) {
      return res.status(400).json({ success: false, message: `Module index ${moduleIdx} not found in template` });
    }

    // Hard sequencing: Check that prior milestone is completed (direct membership, not XP value)
    if (moduleIdx > 0) {
      const isPriorCompleted = progress.completedModules.some((m) => m.moduleIndex === moduleIdx - 1);
      if (!isPriorCompleted) {
        return res.status(400).json({
          success: false,
          message: `Milestone #${moduleIdx + 1} is locked. You must complete Milestone #${moduleIdx} first.`
        });
      }
    }

    let aiFeedback = null;
    if (requestAiFeedback && content) {
      aiFeedback = await evaluateTaskSubmission({
        projectTitle: template.projectIdea,
        moduleTitle: targetModule.title,
        taskInstructions: targetModule.handsOnTask?.instructions || '',
        submissionContent: content,
        submissionType
      });
    }

    const existingIndex = progress.completedModules.findIndex((m) => m.moduleIndex === moduleIdx);
    const submissionData = {
      submissionType,
      content,
      submittedAt: new Date()
    };

    if (existingIndex >= 0) {
      progress.completedModules[existingIndex].submission = submissionData;
      if (aiFeedback) progress.completedModules[existingIndex].aiFeedback = aiFeedback;
    } else {
      progress.completedModules.push({
        moduleIndex: moduleIdx,
        completedAt: new Date(),
        xpAwarded: 0,
        submission: submissionData,
        aiFeedback
      });
    }

    await progress.save();

    res.json({
      success: true,
      submission: submissionData,
      aiFeedback,
      progress
    });
  } catch (err) {
    console.error('[BuildPaths:Submit Error]:', err);
    res.status(500).json({ success: false, message: 'Failed to record task submission' });
  }
});

// @route   POST /api/build-paths/progress/:id/modules/:moduleIndex/complete
// @desc    Mark a module complete and award 50 XP (strictly idempotent: single source of truth, no double-counting)
router.post('/progress/:id/modules/:moduleIndex/complete', protect, async (req, res) => {
  try {
    const moduleIdx = parseInt(req.params.moduleIndex, 10);
    const progress = await UserBuildProgress.findById(req.params.id).populate('templateId');

    if (!progress) {
      return res.status(404).json({ success: false, message: 'Progress record not found' });
    }

    if (progress.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to modify this progress record' });
    }

    const template = progress.templateId;
    const totalModules = template.modules?.length || 1;

    // Hard sequencing: Check that prior milestone is completed (direct membership, not XP value)
    if (moduleIdx > 0) {
      const isPriorCompleted = progress.completedModules.some((m) => m.moduleIndex === moduleIdx - 1);
      if (!isPriorCompleted) {
        return res.status(400).json({
          success: false,
          message: `Milestone #${moduleIdx + 1} is locked. You must complete Milestone #${moduleIdx} first.`
        });
      }
    }

    // Idempotency check: Has this module already been awarded XP?
    const existingEntry = progress.completedModules.find((m) => m.moduleIndex === moduleIdx);
    if (existingEntry && (existingEntry.xpAwarded || 0) > 0) {
      return res.json({
        success: true,
        alreadyCompleted: true,
        xpAwarded: 0,
        message: 'Module already marked complete. No additional XP awarded.',
        progress
      });
    }

    // Award 50 XP via centralized single source of truth
    const xpReward = 50;
    const xpResult = await awardUserXp(req.user.id, xpReward, {
      source: 'Build Path Milestone',
      message: `🎉 Completed Milestone #${moduleIdx + 1} of "${template.projectIdea}" (+50 XP)!`
    });

    if (existingEntry) {
      existingEntry.xpAwarded = xpReward;
      existingEntry.completedAt = new Date();
    } else {
      progress.completedModules.push({
        moduleIndex: moduleIdx,
        completedAt: new Date(),
        xpAwarded: xpReward
      });
    }

    progress.totalXpEarned = (progress.totalXpEarned || 0) + xpReward;

    // Check if entire build path is now finished
    const uniqueCompleted = new Set(progress.completedModules.map((m) => m.moduleIndex));
    if (uniqueCompleted.size >= totalModules) {
      progress.status = 'completed';
    }

    // Soft-sequencing pointer: recommend next incomplete module
    let nextIndex = moduleIdx + 1;
    while (uniqueCompleted.has(nextIndex) && nextIndex < totalModules) {
      nextIndex++;
    }
    progress.currentModuleIndex = Math.min(nextIndex, totalModules - 1);

    await progress.save();

    res.json({
      success: true,
      alreadyCompleted: false,
      xpAwarded: xpReward,
      userStats: xpResult ? { xp: xpResult.xp, level: xpResult.level, leveledUp: xpResult.leveledUp } : null,
      progress
    });
  } catch (err) {
    console.error('[BuildPaths:Complete Error]:', err);
    res.status(500).json({ success: false, message: 'Failed to complete module' });
  }
});

// @route   POST /api/build-paths/progress/:id/modules/:moduleIndex/peer-review
// @desc    Posts task deliverable to Peer Tutor Network with additive isBuildPathReview flag
router.post('/progress/:id/modules/:moduleIndex/peer-review', protect, async (req, res) => {
  try {
    const moduleIdx = parseInt(req.params.moduleIndex, 10);
    const { customNote } = req.body;

    const progress = await UserBuildProgress.findById(req.params.id).populate('templateId');
    if (!progress) {
      return res.status(404).json({ success: false, message: 'Progress record not found' });
    }

    if (progress.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to post review for this progress record' });
    }

    const template = progress.templateId;
    const targetModule = template.modules?.find((m) => m.moduleIndex === moduleIdx);
    if (!targetModule) {
      return res.status(400).json({ success: false, message: 'Target module not found' });
    }

    // Hard sequencing: Check that prior milestone is completed (direct membership, not XP value)
    if (moduleIdx > 0) {
      const isPriorCompleted = progress.completedModules.some((m) => m.moduleIndex === moduleIdx - 1);
      if (!isPriorCompleted) {
        return res.status(400).json({
          success: false,
          message: `Milestone #${moduleIdx + 1} is locked. You must complete Milestone #${moduleIdx} first.`
        });
      }
    }

    const completedEntry = progress.completedModules.find((m) => m.moduleIndex === moduleIdx);
    const submissionContent = completedEntry?.submission?.content || customNote || 'Please review my milestone implementation code and architecture.';

    // Construct clean questionText without baked-in banners
    const questionText = `Review Request for Milestone #${moduleIdx + 1}: "${targetModule.title}" (${template.projectIdea})

Task Requirements:
${targetModule.handsOnTask?.instructions || 'Standard practical implementation'}

Student Deliverable:
${submissionContent}${customNote ? `\n\nStudent Note:\n${customNote}` : ''}`;

    // Create Problem with additive flags
    const problem = await Problem.create({
      userId: req.user.id,
      subject: 'Programming',
      questionText,
      isBuildPathReview: true,
      buildPathMeta: {
        templateId: template._id,
        moduleIndex: moduleIdx,
        moduleTitle: targetModule.title
      }
    });

    if (completedEntry) {
      completedEntry.peerReviewProblemId = problem._id;
      await progress.save();
    }

    res.status(201).json({
      success: true,
      message: 'Milestone deliverable posted to Peer Tutor Network for community review!',
      problem
    });
  } catch (err) {
    console.error('[BuildPaths:PeerReview Error]:', err);
    res.status(500).json({ success: false, message: 'Failed to post peer review request' });
  }
});

// @route   DELETE /api/build-paths/progress/:id
// @desc    Delete a user's build path progress. Only removes UserBuildProgress; BuildPathTemplate is untouched.
router.delete('/progress/:id', protect, async (req, res) => {
  try {
    const progress = await UserBuildProgress.findById(req.params.id);
    if (!progress) {
      return res.status(404).json({ success: false, message: 'Build path progress record not found' });
    }

    if (progress.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this build path' });
    }

    const templateId = progress.templateId;
    await UserBuildProgress.findByIdAndDelete(req.params.id);

    // Verify template remains unaffected
    const templateStillExists = await BuildPathTemplate.exists({ _id: templateId });

    res.json({
      success: true,
      message: 'Build path removed from your workspace. Shared template remains preserved.',
      deletedProgressId: req.params.id,
      templateId,
      templatePreserved: !!templateStillExists
    });
  } catch (err) {
    console.error('[BuildPaths:Delete Error]:', err);
    res.status(500).json({ success: false, message: 'Failed to delete build path progress' });
  }
});

// @route   GET /api/build-paths/mentor/status
// @desc    Check whether Agent37 Project Mentor is enabled & configured on backend
router.get('/mentor/status', optionalAuth, (req, res) => {
  const status = isAgent37Configured();
  res.json({
    success: true,
    enabled: status.enabled,
    configured: status.configured,
    instanceId: status.instanceId,
    reason: status.reason
  });
});

// @route   GET /api/build-paths/progress/:id/modules/:moduleIndex/mentor
// @desc    Retrieve existing mentor conversation history for this milestone
router.get('/progress/:id/modules/:moduleIndex/mentor', protect, async (req, res) => {
  try {
    const moduleIdx = parseInt(req.params.moduleIndex, 10);
    const progress = await UserBuildProgress.findById(req.params.id);

    if (!progress) {
      return res.status(404).json({ success: false, message: 'Progress record not found' });
    }

    if (progress.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to access mentor for this progress record' });
    }

    const config = isAgent37Configured();

    const session = await ProjectMentorSession.findOne({
      userId: req.user.id,
      progressId: progress._id,
      moduleIndex: moduleIdx
    }).lean();

    res.json({
      success: true,
      enabled: config.enabled,
      configured: config.configured,
      instanceId: config.instanceId,
      reason: config.reason,
      messages: session?.messages || [],
      sessionId: session?.agent37SessionId || null
    });
  } catch (err) {
    console.error('[BuildPaths:GetMentorHistory Error]:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve mentor session history' });
  }
});

// @route   POST /api/build-paths/progress/:id/modules/:moduleIndex/mentor
// @desc    Ask EduVerse AI Project Mentor (powered by Agent37) for contextual guidance on this milestone
router.post('/progress/:id/modules/:moduleIndex/mentor', protect, mentorRateLimiter, async (req, res) => {
  try {
    const { message, submissionContent } = req.body;
    const moduleIdx = parseInt(req.params.moduleIndex, 10);

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'A question or description of your difficulty is required.'
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'Question exceeds maximum limit of 2000 characters.'
      });
    }

    const progress = await UserBuildProgress.findById(req.params.id).populate('templateId');
    if (!progress) {
      return res.status(404).json({ success: false, message: 'Progress record not found' });
    }

    if (progress.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to access this build path' });
    }

    const template = progress.templateId;
    const targetModule = template.modules?.find((m) => m.moduleIndex === moduleIdx);
    if (!targetModule) {
      return res.status(400).json({ success: false, message: `Module index ${moduleIdx} not found in template` });
    }

    // Verify milestone is accessible (unlocked)
    if (moduleIdx > 0) {
      const isPriorCompleted = progress.completedModules.some((m) => m.moduleIndex === moduleIdx - 1);
      if (!isPriorCompleted) {
        return res.status(400).json({
          success: false,
          message: `Milestone #${moduleIdx + 1} is locked. You must complete Milestone #${moduleIdx} first.`
        });
      }
    }

    // Check backend Agent37 configuration
    const config = isAgent37Configured();
    if (!config.configured) {
      return res.status(503).json({
        success: false,
        configured: false,
        enabled: config.enabled,
        message: config.reason || 'AI Project Mentor powered by Agent37 is not configured in this environment.',
        mentorGuidance: null
      });
    }

    // Gather candidate resources from application data for Skills Hub linkage
    const candidateResources = [];

    // 1. Module official documentation link
    if (targetModule.docLink?.url) {
      candidateResources.push({
        title: targetModule.docLink.title || `${targetModule.title} Official Docs`,
        url: targetModule.docLink.url,
        type: 'documentation',
        skillId: null,
        destination: targetModule.docLink.url,
        label: 'View Official Documentation'
      });
    }

    // 2. Module curated YouTube videos
    if (Array.isArray(targetModule.youtubeResources)) {
      targetModule.youtubeResources.slice(0, 3).forEach((vid) => {
        candidateResources.push({
          title: vid.title,
          url: vid.url,
          type: 'video',
          skillId: null,
          destination: vid.url,
          label: 'Watch Recommended Tutorial'
        });
      });
    }

    // 3. User enrolled Skills in Skills Hub
    try {
      const userSkills = await Skill.find({ userId: req.user.id })
        .select('_id title category videoUrl progress')
        .limit(5)
        .lean();

      if (Array.isArray(userSkills)) {
        userSkills.forEach((sk) => {
          candidateResources.push({
            title: sk.title,
            url: sk.videoUrl,
            type: 'skill_hub',
            skillId: sk._id.toString(),
            destination: `/skills/${sk._id}/learn`,
            label: `Open "${sk.title}" in Skills Hub`
          });
        });
      }
    } catch (skillErr) {
      console.warn('[BuildPaths:Mentor] Failed to load user skills:', skillErr.message);
    }

    // Find any prior completed entry or submission
    const completedEntry = progress.completedModules.find((m) => m.moduleIndex === moduleIdx);
    const effectiveSubmission = submissionContent
      ? { content: submissionContent }
      : (completedEntry?.submission || null);

    // Build context-rich input prompt
    const agentInput = buildMentorInput({
      projectTitle: template.projectIdea,
      techStack: template.techStack,
      skillLevel: template.skillLevel,
      projectOverview: template.overview,
      milestoneIndex: moduleIdx,
      milestoneTitle: targetModule.title,
      milestoneDescription: targetModule.description,
      taskInstructions: targetModule.handsOnTask?.instructions,
      evaluationCriteria: targetModule.handsOnTask?.evaluationCriteria,
      priorSubmission: effectiveSubmission,
      priorFeedback: completedEntry?.aiFeedback,
      availableResources: candidateResources,
      userQuestion: message.trim()
    });

    // Retrieve or create ProjectMentorSession
    let mentorSession = await ProjectMentorSession.findOne({
      userId: req.user.id,
      progressId: progress._id,
      moduleIndex: moduleIdx
    });

    if (!mentorSession) {
      mentorSession = new ProjectMentorSession({
        userId: req.user.id,
        progressId: progress._id,
        templateId: template._id,
        moduleIndex: moduleIdx,
        messages: []
      });
    }

    // Call Agent37 with existing session_id if present
    const agentResponse = await callAgent37MessagingAPI({
      input: agentInput,
      sessionId: mentorSession.agent37SessionId || null
    });

    // Derive recommended resource from verified candidates
    const recommendedResource = matchRecommendedResource(agentResponse.outputText, candidateResources);

    // Save turn to ProjectMentorSession
    mentorSession.messages.push({
      role: 'user',
      content: message.trim(),
      timestamp: new Date()
    });

    mentorSession.messages.push({
      role: 'assistant',
      content: agentResponse.outputText,
      recommendedResource,
      timestamp: new Date()
    });

    // Bound message history to last 30 messages
    if (mentorSession.messages.length > 30) {
      mentorSession.messages = mentorSession.messages.slice(-30);
    }

    if (agentResponse.sessionId) {
      mentorSession.agent37SessionId = agentResponse.sessionId;
    }

    await mentorSession.save();

    res.json({
      success: true,
      configured: true,
      answer: agentResponse.outputText,
      sessionId: mentorSession.agent37SessionId,
      recommendedResource,
      messages: mentorSession.messages
    });
  } catch (err) {
    console.error('[BuildPaths:Mentor Error]:', err.message);
    res.status(err.status || 500).json({
      success: false,
      code: err.code || 'AGENT37_ERROR',
      message: err.message || 'Failed to receive guidance from AI Project Mentor'
    });
  }
});

module.exports = router;
