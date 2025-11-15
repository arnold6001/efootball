require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/efootball', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', () => console.log('Connected to MongoDB'));

// Schemas
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  email: String,
  password: String,
  tournaments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' }]
});

const TournamentSchema = new mongoose.Schema({
  name: String,
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  fixtures: [{
    home: String,
    away: String,
    homeScore: { type: Number, default: 0 },
    awayScore: { type: Number, default: 0 },
    played: { type: Boolean, default: false }
  }],
  standings: [{
    player: String,
    played: { type: Number, default: 0 },
    won: { type: Number, default: 0 },
    drawn: { type: Number, default: 0 },
    lost: { type: Number, default: 0 },
    gf: { type: Number, default: 0 },
    ga: { type: Number, default: 0 },
    gd: { type: Number, default: 0 },
    points: { type: Number, default: 0 }
  }],
  createdBy: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Tournament = mongoose.model('Tournament', TournamentSchema);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'efootball-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/efootball' })
}));

// Routes
app.get('/', (req, res) => res.render('index', { user: req.session.user }));
app.get('/register', (req, res) => res.render('register'));
app.get('/login', (req, res) => res.render('login'));
app.get('/dashboard', auth, (req, res) => res.render('dashboard', { user: req.session.user }));
app.get('/tournament/:id', auth, async (req, res) => {
  const tournament = await Tournament.findById(req.params.id).lean();
  res.render('tournament', { tournament, user: req.session.user });
});

// Register
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  try {
    const user = await User.create({ username, email, password: hashed });
    req.session.user = user;
    res.redirect('/dashboard');
  } catch (err) {
    res.redirect('/register?error=Username taken');
  }
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (user && await bcrypt.compare(password, user.password)) {
    req.session.user = user;
    res.redirect('/dashboard');
  } else {
    res.redirect('/login?error=Invalid credentials');
  }
});

// Create Tournament
app.post('/tournament/create', auth, async (req, res) => {
  const { name } = req.body;
  const tournament = await Tournament.create({
    name,
    createdBy: req.session.user.username
  });
  res.redirect('/dashboard');
});

// Join Tournament
app.post('/tournament/join/:id', auth, async (req, res) => {
  const tournament = await Tournament.findById(req.params.id);
  if (!tournament.players.includes(req.session.user._id)) {
    tournament.players.push(req.session.user._id);
    await tournament.save();
  }
  res.redirect('/tournament/' + req.params.id);
});

// Generate Fixtures (Auto)
app.post('/tournament/generate/:id', auth, async (req, res) => {
  const tournament = await Tournament.findById(req.params.id).populate('players');
  const players = tournament.players.map(p => p.username);

  if (players.length < 2) return res.redirect('/tournament/' + req.params.id);

  const fixtures = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      fixtures.push({ home: players[i], away: players[j] });
      fixtures.push({ home: players[j], away: players[i] }); // Return leg
    }
  }

  tournament.fixtures = fixtures;
  tournament.standings = players.map(p => ({
    player: p, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0
  }));

  await tournament.save();
  res.redirect('/tournament/' + req.params.id);
});

// Update Score
app.post('/tournament/score/:id', auth, async (req, res) => {
  const { homeScore, awayScore, fixtureIndex } = req.body;
  const tournament = await Tournament.findById(req.params.id);
  const fixture = tournament.fixtures[fixtureIndex];

  fixture.homeScore = parseInt(homeScore);
  fixture.awayScore = parseInt(awayScore);
  fixture.played = true;

  // Update standings
  const home = tournament.standings.find(s => s.player === fixture.home);
  const away = tournament.standings.find(s => s.player === fixture.away);

  home.played++; away.played++;
  home.gf += fixture.homeScore; away.gf += fixture.awayScore;
  home.ga += fixture.awayScore; away.ga += fixture.homeScore;
  home.gd = home.gf - home.ga; away.gd = away.gf - away.ga;

  if (fixture.homeScore > fixture.awayScore) {
    home.won++; home.points += 3; away.lost++;
  } else if (fixture.homeScore < fixture.awayScore) {
    away.won++; away.points += 3; home.lost++;
  } else {
    home.drawn++; away.drawn++; home.points++; away.points++;
  }

  tournament.standings.sort((a, b) => b.points - a.points || b.gd - a.gd);

  await tournament.save();
  res.redirect('/tournament/' + req.params.id);
});

// Auth Middleware
function auth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));