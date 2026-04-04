import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env manually (no dotenv needed for simple case) ─────────────────
function loadEnv() {
  try {
    const env = readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    }
  } catch {}
}
loadEnv();

const JWT_SECRET = process.env.JWT_SECRET || 'promptcraft-secret-change-me';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FREE_RUN_LIMIT = 10;
const PRO_RUN_LIMIT = 140;

// ── Database ──────────────────────────────────────────────────────────────
const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: [], communityPrompts: [] });
await db.read();
if (!db.data.communityPrompts) db.data.communityPrompts = [];
if (!db.data.teams) db.data.teams = [];
if (!db.data.teamMembers) db.data.teamMembers = [];
if (!db.data.teamInvites) db.data.teamInvites = [];
if (!db.data.teamPrompts) db.data.teamPrompts = [];
if (!db.data.certificates) db.data.certificates = [];

// ── Express setup ─────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Serve promptcraft.html at the root and as a static fallback
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'promptcraft.html')));
app.use(express.static(__dirname));

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function getUser(id) {
  return db.data.users.find(u => u.id === id);
}

function requireTeamRole(...roles) {
  return (req, res, next) => {
    const user = getUser(req.user.id);
    if (!user?.teamId) return res.status(403).json({ error: 'Not a team member' });
    if (req.params.teamId && user.teamId !== req.params.teamId)
      return res.status(403).json({ error: 'Wrong team' });
    const member = db.data.teamMembers.find(m => m.userId === user.id && m.teamId === user.teamId);
    if (!member || !roles.includes(member.role))
      return res.status(403).json({ error: 'Insufficient role' });
    req.teamMember = member;
    next();
  };
}

// ── Reset monthly runs if month changed ───────────────────────────────────
function checkMonthReset(user) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  if (user.sbResetMonth !== monthKey) {
    user.sbRunsThisMonth = 0;
    user.sbResetMonth = monthKey;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (db.data.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
  const user = { id, name, email: email.toLowerCase(), passwordHash, plan: 'free', sbRunsThisMonth: 0, sbResetMonth: monthKey, xp: 0, streak: 1, lastVisit: '', completedLessons: [], passedMissions: [], teamId: null, teamRole: null };
  db.data.users.push(user);
  await db.write();
  const token = jwt.sign({ id, email: user.email, name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, name, email: user.email, plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, xp: user.xp, streak: user.streak, lastVisit: user.lastVisit, completedLessons: user.completedLessons, passedMissions: user.passedMissions, teamId: user.teamId, teamRole: user.teamRole } });
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.data.users.find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  checkMonthReset(user);
  await db.write();
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, xp: user.xp, streak: user.streak, lastVisit: user.lastVisit, completedLessons: user.completedLessons, passedMissions: user.passedMissions, teamId: user.teamId || null, teamRole: user.teamRole || null } });
});

// GET /api/me
app.get('/api/me', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  checkMonthReset(user);
  await db.write();
  res.json({ id: user.id, name: user.name, email: user.email, plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, xp: user.xp, streak: user.streak, lastVisit: user.lastVisit, completedLessons: user.completedLessons, passedMissions: user.passedMissions, teamId: user.teamId || null, teamRole: user.teamRole || null });
});

// PUT /api/me/progress
app.put('/api/me/progress', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const { xp, streak, lastVisit, completedLessons, passedMissions } = req.body;
  if (xp !== undefined) user.xp = xp;
  if (streak !== undefined) user.streak = streak;
  if (lastVisit !== undefined) user.lastVisit = lastVisit;
  if (completedLessons !== undefined) user.completedLessons = completedLessons;
  if (passedMissions !== undefined) user.passedMissions = passedMissions;
  
  await db.write();
  res.json({ success: true });
});

// PUT /api/me/profile — update name and/or password
app.put('/api/me/profile', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, currentPassword, newPassword } = req.body;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    user.name = name.trim();
  }
  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
  }
  await db.write();
  res.json({ success: true, name: user.name });
});

// PUT /api/me/plan — toggle between free and pro (dev/demo toggle)
app.put('/api/me/plan', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { plan } = req.body;
  if (plan !== 'free' && plan !== 'pro') return res.status(400).json({ error: 'Plan must be "free" or "pro"' });
  user.plan = plan;
  await db.write();
  const limit = plan === 'pro' ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  res.json({ plan: user.plan, sbRunsThisMonth: user.sbRunsThisMonth, limit });
});

// POST /api/sandbox/run  — proxy to Claude + enforce monthly limit
app.post('/api/sandbox/run', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  checkMonthReset(user);

  const limit = user.plan === 'pro' ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  if (user.sbRunsThisMonth >= limit) {
    await db.write();
    return res.status(429).json({ error: 'Monthly sandbox limit reached', limit, used: user.sbRunsThisMonth });
  }

  const { systemPrompt, userText } = req.body;
  if (!systemPrompt || !userText) return res.status(400).json({ error: 'systemPrompt and userText are required' });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    });
    const text = message.content[0]?.text;
    if (!text) throw new Error('Empty response from Claude');

    user.sbRunsThisMonth++;
    await db.write();
    res.json({ result: text, sbRunsThisMonth: user.sbRunsThisMonth, limit });
  } catch (err) {
    res.status(502).json({ error: 'Claude request failed: ' + err.message });
  }
});

// POST /api/sandbox/dissect  — proxy to Claude to dissect a prompt
app.post('/api/sandbox/dissect', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  checkMonthReset(user);

  const limit = user.plan === 'pro' ? PRO_RUN_LIMIT : FREE_RUN_LIMIT;
  if (user.sbRunsThisMonth >= limit) {
    await db.write();
    return res.status(429).json({ error: 'Monthly sandbox limit reached', limit, used: user.sbRunsThisMonth });
  }

  const { userText } = req.body;
  if (!userText) return res.status(400).json({ error: 'userText is required' });

  const systemPrompt = `You are an AI teaching assistant for prompt engineering.
Your task is to dissect a user-provided prompt to identify its core components: Role, Format, Tone, Constraint, and Context.
Output exactly a JSON object, with no markdown wrappers or extra text.
The object should have these keys (only include a key if you genuinely find that component in the prompt):
- "role": The portion of the text setting the persona, e.g. "Act as a senior software engineer".
- "format": The portion specifying output structure, e.g. "Create a bulleted list".
- "tone": Tone/voice direction, e.g. "Professional and encouraging".
- "constraint": Explicit limits, e.g. "Under 100 words" or "No jargon".
- "context": Background information, targeting info, or scenario details.

Only extract the exact substrings or slight functional paraphrases from the text.
Example valid output format:
{"role": "You are a senior UX designer", "format": "create a quick bulleted list", "constraint": "Limit to top 3 issues"}
If none of these are strongly clear, return an empty object {}.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Prompt to dissect: ' + userText }],
    });
    const text = message.content[0]?.text;
    if (!text) throw new Error('Empty response from Claude');

    let parsed;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch(e) {
      throw new Error('Claude did not return valid JSON');
    }

    user.sbRunsThisMonth++;
    await db.write();
    res.json({ result: parsed, sbRunsThisMonth: user.sbRunsThisMonth, limit });
  } catch (err) {
    res.status(502).json({ error: 'Claude request failed: ' + err.message });
  }
});

// ── Content filter ────────────────────────────────────────────────────────
const BLOCKED_TERMS = [
  // Violence / harm
  'kill','murder','rape','suicide','bomb','terrorist','weapon','shoot','stab','attack',
  // Hate / slurs (abbreviated to avoid listing them here)
  'nazi','genocide','slur',
  // Sexual / explicit
  'porn','nude','naked','sex','explicit','nsfw','erotic','fetish','masturbat',
  // Personal data / scams
  'social security','credit card','phishing','scam','hack','malware','password',
  // Drugs
  'cocaine','heroin','meth','fentanyl','drug deal',
];
function isAppropriate(text) {
  const lower = text.toLowerCase();
  return !BLOCKED_TERMS.some(term => lower.includes(term));
}

// GET /api/library — public community prompts
app.get('/api/library', (req, res) => {
  res.json(db.data.communityPrompts);
});

// POST /api/library — publish a prompt (pro only, score > 90, content filter)
app.post('/api/library', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) {
    const team = db.data.teams.find(t => t.id === user.teamId);
    if (team?.settings?.blockCommunityPublish) {
      return res.status(403).json({ error: 'Community publishing disabled by your team admin' });
    }
  }
  if (user.plan !== 'pro') return res.status(403).json({ error: 'Pro plan required to publish prompts' });

  const { prompt, title, category, score } = req.body;
  if (!prompt || !title || !category) return res.status(400).json({ error: 'prompt, title, and category are required' });
  if (!score || score < 90) return res.status(400).json({ error: 'Only prompts scoring 90 or above can be published' });
  if (!isAppropriate(prompt) || !isAppropriate(title)) {
    return res.status(422).json({ error: 'Prompt contains inappropriate content and cannot be published' });
  }

  const entry = {
    id: 'u_' + crypto.randomUUID(),
    cat: category,
    title: title.trim().substring(0, 80),
    prompt: prompt.trim(),
    score,
    uses: 0,
    publishedBy: user.name,
    publishedAt: new Date().toISOString(),
  };
  db.data.communityPrompts.unshift(entry);
  await db.write();
  res.json({ success: true, entry });
});

// ── Teams ─────────────────────────────────────────────────────────────────

// POST /api/teams — create a team
app.post('/api/teams', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) return res.status(409).json({ error: 'Already on a team' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });
  const teamId = 'team_' + crypto.randomUUID();
  const team = {
    id: teamId,
    name: name.trim(),
    ownerId: user.id,
    createdAt: new Date().toISOString(),
    settings: {
      showStreaks: true, showXP: true, leaderboardType: 'team',
      blockCommunityPublish: false, requirePromptApproval: true
    },
    assignedCategories: {}
  };
  db.data.teams.push(team);
  const member = { id: 'tm_' + crypto.randomUUID(), teamId, userId: user.id, role: 'owner', joinedAt: new Date().toISOString() };
  db.data.teamMembers.push(member);
  user.teamId = teamId;
  user.teamRole = 'owner';
  await db.write();
  res.json({ team, role: 'owner' });
});

// GET /api/teams/mine
app.get('/api/teams/mine', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.teamId) return res.json({ team: null });
  const team = db.data.teams.find(t => t.id === user.teamId);
  if (!team) return res.json({ team: null });
  const member = db.data.teamMembers.find(m => m.userId === user.id && m.teamId === user.teamId);
  const memberCount = db.data.teamMembers.filter(m => m.teamId === user.teamId).length;
  // Inject defaults for any settings fields added after team creation
  const settingDefaults = { showStreaks: true, showXP: true, leaderboardType: 'team', blockCommunityPublish: false, requirePromptApproval: true, enableTeamLibrary: true };
  const teamWithDefaults = { ...team, settings: { ...settingDefaults, ...(team.settings || {}) } };
  res.json({ team: teamWithDefaults, role: member?.role || 'member', memberCount });
});

// PUT /api/teams/:teamId/settings
app.put('/api/teams/:teamId/settings', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const team = db.data.teams.find(t => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const allowed = ['showStreaks','showXP','leaderboardType','blockCommunityPublish','requirePromptApproval','enableTeamLibrary'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) team.settings[k] = req.body[k];
  }
  await db.write();
  console.log("body:", req.body, "team settings after:", team.settings); res.json({ success: true, settings: team.settings });
});

// PUT /api/teams/:teamId/name
app.put('/api/teams/:teamId/name', requireAuth, (req, res, next) => requireTeamRole('owner')(req, res, next), async (req, res) => {
  const team = db.data.teams.find(t => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });
  team.name = name.trim();
  await db.write();
  res.json({ success: true, name: team.name });
});

// PUT /api/teams/:teamId/categories
app.put('/api/teams/:teamId/categories', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const team = db.data.teams.find(t => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const { assignedCategories } = req.body;
  if (assignedCategories && typeof assignedCategories === 'object') {
    team.assignedCategories = assignedCategories;
  }
  await db.write();
  res.json({ success: true, assignedCategories: team.assignedCategories });
});

// ── Invites ───────────────────────────────────────────────────────────────

// POST /api/teams/:teamId/invites
app.post('/api/teams/:teamId/invites', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { label } = req.body;
  const token = randomBytes(32).toString('hex');
  const invite = {
    id: 'inv_' + crypto.randomUUID(), teamId: req.params.teamId,
    token, createdBy: req.user.id, label: label || '',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30*24*60*60*1000).toISOString(),
    usedBy: null, usedAt: null
  };
  db.data.teamInvites.push(invite);
  await db.write();
  res.json({ invite, link: `/?invite=${token}` });
});

// POST /api/teams/:teamId/invites/bulk
app.post('/api/teams/:teamId/invites/bulk', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { labels } = req.body;
  if (!Array.isArray(labels) || labels.length === 0) return res.status(400).json({ error: 'labels array required' });
  if (labels.length > 50) return res.status(400).json({ error: 'Maximum 50 invites at once' });
  const invites = labels.map(label => {
    const token = randomBytes(32).toString('hex');
    return {
      id: 'inv_' + crypto.randomUUID(), teamId: req.params.teamId,
      token, createdBy: req.user.id, label: label || '',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30*24*60*60*1000).toISOString(),
      usedBy: null, usedAt: null
    };
  });
  db.data.teamInvites.push(...invites);
  await db.write();
  res.json({ invites: invites.map(inv => ({ ...inv, link: `/?invite=${inv.token}` })) });
});

// GET /api/teams/:teamId/invites
app.get('/api/teams/:teamId/invites', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), (req, res) => {
  const now = new Date().toISOString();
  const pending = db.data.teamInvites.filter(inv =>
    inv.teamId === req.params.teamId && !inv.usedBy && inv.expiresAt > now
  );
  res.json(pending.map(inv => ({ ...inv, link: `/?invite=${inv.token}` })));
});

// DELETE /api/teams/:teamId/invites/:inviteId
app.delete('/api/teams/:teamId/invites/:inviteId', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const idx = db.data.teamInvites.findIndex(inv => inv.id === req.params.inviteId && inv.teamId === req.params.teamId);
  if (idx === -1) return res.status(404).json({ error: 'Invite not found' });
  db.data.teamInvites.splice(idx, 1);
  await db.write();
  res.json({ success: true });
});

// GET /api/invites/:token — public preview
app.get('/api/invites/:token', (req, res) => {
  const inv = db.data.teamInvites.find(i => i.token === req.params.token);
  if (!inv) return res.json({ valid: false, reason: 'Invalid invite link' });
  if (inv.usedBy) return res.json({ valid: false, reason: 'This invite has already been used' });
  if (new Date(inv.expiresAt) < new Date()) return res.json({ valid: false, reason: 'This invite has expired' });
  const team = db.data.teams.find(t => t.id === inv.teamId);
  const creator = db.data.users.find(u => u.id === inv.createdBy);
  res.json({ valid: true, teamName: team?.name || 'Unknown Team', inviterName: creator?.name || 'Someone' });
});

// POST /api/invites/:token/accept
app.post('/api/invites/:token/accept', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.teamId) return res.status(409).json({ error: 'Already on a team' });
  const inv = db.data.teamInvites.find(i => i.token === req.params.token);
  if (!inv) return res.status(404).json({ error: 'Invalid invite link' });
  if (inv.usedBy) return res.status(410).json({ error: 'This invite has already been used' });
  if (new Date(inv.expiresAt) < new Date()) return res.status(410).json({ error: 'This invite has expired' });
  const member = { id: 'tm_' + crypto.randomUUID(), teamId: inv.teamId, userId: user.id, role: 'member', joinedAt: new Date().toISOString() };
  db.data.teamMembers.push(member);
  inv.usedBy = user.id;
  inv.usedAt = new Date().toISOString();
  user.teamId = inv.teamId;
  user.teamRole = 'member';
  await db.write();
  const team = db.data.teams.find(t => t.id === inv.teamId);
  res.json({ success: true, team, role: 'member' });
});

// ── Members ───────────────────────────────────────────────────────────────

// GET /api/teams/:teamId/members
app.get('/api/teams/:teamId/members', requireAuth, (req, res, next) => requireTeamRole('owner','admin','member')(req, res, next), (req, res) => {
  const members = db.data.teamMembers.filter(m => m.teamId === req.params.teamId);
  const result = members.map(m => {
    const u = getUser(m.userId);
    if (!u) return null;
    return {
      id: u.id, name: u.name, role: m.role, joinedAt: m.joinedAt,
      lastVisit: u.lastVisit, streak: u.streak || 0, xp: u.xp || 0,
      lessonsCompleted: (u.completedLessons || []).length,
      missionsPassed: (u.passedMissions || []).length
    };
  }).filter(Boolean);
  res.json(result);
});

// PUT /api/teams/:teamId/members/:userId/role
app.put('/api/teams/:teamId/members/:userId/role', requireAuth, (req, res, next) => requireTeamRole('owner')(req, res, next), async (req, res) => {
  const { role } = req.body;
  if (!['admin','member'].includes(role)) return res.status(400).json({ error: 'Role must be admin or member' });
  const team = db.data.teams.find(t => t.id === req.params.teamId);
  if (req.params.userId === team.ownerId) return res.status(400).json({ error: 'Cannot change owner role' });
  const member = db.data.teamMembers.find(m => m.userId === req.params.userId && m.teamId === req.params.teamId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  member.role = role;
  const targetUser = getUser(req.params.userId);
  if (targetUser) targetUser.teamRole = role;
  await db.write();
  res.json({ success: true, role });
});

// DELETE /api/teams/:teamId/members/:userId
app.delete('/api/teams/:teamId/members/:userId', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const team = db.data.teams.find(t => t.id === req.params.teamId);
  if (req.params.userId === team.ownerId) return res.status(400).json({ error: 'Cannot remove the team owner' });
  const idx = db.data.teamMembers.findIndex(m => m.userId === req.params.userId && m.teamId === req.params.teamId);
  if (idx === -1) return res.status(404).json({ error: 'Member not found' });
  db.data.teamMembers.splice(idx, 1);
  const targetUser = getUser(req.params.userId);
  if (targetUser) { targetUser.teamId = null; targetUser.teamRole = null; }
  await db.write();
  res.json({ success: true });
});

// DELETE /api/teams/leave
app.delete('/api/teams/leave', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.teamId) return res.status(400).json({ error: 'Not on a team' });
  const team = db.data.teams.find(t => t.id === user.teamId);
  if (team && team.ownerId === user.id) return res.status(400).json({ error: 'Owner cannot leave. Transfer ownership first.' });
  const idx = db.data.teamMembers.findIndex(m => m.userId === user.id && m.teamId === user.teamId);
  if (idx !== -1) db.data.teamMembers.splice(idx, 1);
  user.teamId = null;
  user.teamRole = null;
  await db.write();
  res.json({ success: true });
});

// ── Team Analytics ────────────────────────────────────────────────────────

// GET /api/teams/:teamId/analytics
app.get('/api/teams/:teamId/analytics', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), (req, res) => {
  const members = db.data.teamMembers.filter(m => m.teamId === req.params.teamId);
  const users = members.map(m => getUser(m.userId)).filter(Boolean);
  if (users.length === 0) return res.json({ completionRate: 0, categoryBreakdown: [], topPerformers: [] });
  const totalLessons = 13; // approximate total lessons across all tracks
  const completionRates = users.map(u => (u.completedLessons || []).length / totalLessons);
  const avgCompletion = completionRates.reduce((a, b) => a + b, 0) / users.length;
  const categories = ['core','writing','code','research','marketing','productivity','learning','data','design','hr','legal','finance','selfdev'];
  const categoryBreakdown = categories.map(cat => {
    const avgPct = users.reduce((sum, u) => {
      const done = (u.completedLessons || []).filter(l => l.startsWith(cat[0])).length;
      return sum + done;
    }, 0) / users.length;
    return { categoryId: cat, avgPct: Math.round(avgPct * 100) };
  });
  const topPerformers = users.map(u => ({ id: u.id, name: u.name, xp: u.xp || 0, lessonsCompleted: (u.completedLessons||[]).length }))
    .sort((a, b) => b.xp - a.xp).slice(0, 5);
  res.json({ completionRate: Math.round(avgCompletion * 100), categoryBreakdown, topPerformers });
});

// ── Team Prompt Library ───────────────────────────────────────────────────

// GET /api/teams/:teamId/prompts
app.get('/api/teams/:teamId/prompts', requireAuth, (req, res, next) => requireTeamRole('owner','admin','member')(req, res, next), (req, res) => {
  const isAdminOrOwner = ['owner','admin'].includes(req.teamMember.role);
  const prompts = db.data.teamPrompts
    .filter(p => {
      if (p.teamId !== req.params.teamId) return false;
      if (isAdminOrOwner) return true;
      return p.status === 'approved';
    })
    .map(p => {
      if (p.publishedBy) return p;
      const u = db.data.users.find(u => u.id === p.submittedBy);
      return { ...p, publishedBy: u?.name || 'Unknown' };
    });
  res.json(prompts);
});

// POST /api/teams/:teamId/prompts
app.post('/api/teams/:teamId/prompts', requireAuth, (req, res, next) => requireTeamRole('owner','admin','member')(req, res, next), async (req, res) => {
  const { title, prompt, category, score } = req.body;
  if (!title || !prompt || !category) return res.status(400).json({ error: 'title, prompt, category required' });
  if (!score || score < 85) return res.status(400).json({ error: 'Score must be 85 or above' });
  if (!isAppropriate(prompt) || !isAppropriate(title)) return res.status(422).json({ error: 'Content contains inappropriate material' });
  const team = db.data.teams.find(t => t.id === req.params.teamId);
  const status = team?.settings?.requirePromptApproval ? 'pending' : 'approved';
  const submitter = getUser(req.user.id);
  const entry = {
    id: 'tp_' + crypto.randomUUID(), teamId: req.params.teamId,
    submittedBy: req.user.id, publishedBy: submitter?.name || 'Unknown',
    title: title.trim().substring(0, 80),
    prompt: prompt.trim(), category, score, status,
    reviewedBy: null, reviewedAt: null,
    submittedAt: new Date().toISOString(), uses: 0
  };
  db.data.teamPrompts.push(entry);
  await db.write();
  res.json({ success: true, entry });
});

// PUT /api/teams/:teamId/prompts/:promptId/review
app.put('/api/teams/:teamId/prompts/:promptId/review', requireAuth, (req, res, next) => requireTeamRole('owner','admin')(req, res, next), async (req, res) => {
  const { action } = req.body;
  if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
  const prompt = db.data.teamPrompts.find(p => p.id === req.params.promptId && p.teamId === req.params.teamId);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  prompt.status = action === 'approve' ? 'approved' : 'rejected';
  prompt.reviewedBy = req.user.id;
  prompt.reviewedAt = new Date().toISOString();
  await db.write();
  res.json({ success: true, status: prompt.status });
});

// DELETE /api/teams/:teamId/prompts/:promptId
app.delete('/api/teams/:teamId/prompts/:promptId', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const prompt = db.data.teamPrompts.find(p => p.id === req.params.promptId && p.teamId === req.params.teamId);
  if (!prompt) return res.status(404).json({ error: 'Prompt not found' });
  const member = db.data.teamMembers.find(m => m.userId === user.id && m.teamId === req.params.teamId);
  if (!member) return res.status(403).json({ error: 'Not a team member' });
  if (!['owner','admin'].includes(member.role) && prompt.submittedBy !== user.id)
    return res.status(403).json({ error: 'Insufficient permissions' });
  const idx = db.data.teamPrompts.findIndex(p => p.id === req.params.promptId);
  db.data.teamPrompts.splice(idx, 1);
  await db.write();
  res.json({ success: true });
});

// ── Certificates ──────────────────────────────────────────────────────────

// POST /api/certificates
app.post('/api/certificates', requireAuth, async (req, res) => {
  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { type, categoryId, categoryName } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  const existing = db.data.certificates.find(c => c.userId === user.id && c.type === type && c.categoryId === categoryId);
  if (existing) return res.json({ cert: existing, alreadyExists: true });
  const cert = {
    id: 'cert_' + crypto.randomUUID(), userId: user.id, teamId: user.teamId || null,
    type, categoryId: categoryId || null, categoryName: categoryName || null,
    earnedAt: new Date().toISOString()
  };
  db.data.certificates.push(cert);
  await db.write();
  res.json({ cert });
});

// GET /api/certificates/mine
app.get('/api/certificates/mine', requireAuth, (req, res) => {
  const certs = db.data.certificates.filter(c => c.userId === req.user.id);
  res.json(certs);
});

// Modify POST /api/library to check blockCommunityPublish
// (already defined above — we patch by overriding the route handler logic via checking team settings)

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PromptCraft server running at http://localhost:${PORT}`));
