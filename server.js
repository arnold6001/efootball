// server.js (SQLite - NO MONGO)
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure data folder exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const dbPath = path.join(DATA_DIR, 'efootball.db');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(dbPath);

// Initialize DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    createdBy TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tournament_players (
    tournament_id INTEGER,
    user_id INTEGER,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS fixtures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    home TEXT,
    away TEXT,
    homeScore INTEGER DEFAULT 0,
    awayScore INTEGER DEFAULT 0,
    played INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS standings (
    tournament_id INTEGER,
    player TEXT,
    played INTEGER DEFAULT 0,
    won INTEGER DEFAULT 0,
    drawn INTEGER DEFAULT 0,
    lost INTEGER DEFAULT 0,
    gf INTEGER DEFAULT 0,
    ga INTEGER DEFAULT 0,
    gd INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0
  )`);
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'efootball-secret-2025',
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: dbPath })
}));

// Routes
app.get('/', (req, res) => res.render('index', { user: req.session.user }));
app.get('/register', (req, res) => res.render('register'));
app.get('/login', (req, res) => res.render('login'));
app.get('/dashboard', auth, async (req, res) => {
  db.all(`SELECT t.* FROM tournaments t
          JOIN tournament_players tp ON t.id = tp.tournament_id
          WHERE tp.user_id = ?`, [req.session.user.id], (err, tournaments) => {
    res.render('dashboard', { user: req.session.user, tournaments });
  });
});

app.get('/tournament/:id', auth, (req, res) => {
  const tid = req.params.id;
  db.get(`SELECT * FROM tournaments WHERE id = ?`, [tid], (err, tournament) => {
    db.all(`SELECT u.username FROM users u
            JOIN tournament_players tp ON u.id = tp.user_id
            WHERE tp.tournament_id = ?`, [tid], (err, players) => {
      db.all(`SELECT * FROM fixtures WHERE tournament_id = ?`, [tid], (err, fixtures) => {
        db.all(`SELECT * FROM standings WHERE tournament_id = ? ORDER BY points DESC, gd DESC`, [tid], (err, standings) => {
          res.render('tournament', { tournament, players: players.map(p => p.username), fixtures, standings, user: req.session.user });
        });
      });
    });
  });
});

// Register
app.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  bcrypt.hash(password, 10, (err, hash) => {
    db.run(`INSERT INTO users (username, email, password) VALUES (?, ?, ?)`, [username, email, hash], function(err) {
      if (err) return res.redirect('/register?error=Username taken');
      req.session.user = { id: this.lastID, username };
      res.redirect('/dashboard');
    });
  });
});

// Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (!user) return res.redirect('/login?error=Invalid');
    bcrypt.compare(password, user.password, (err, match) => {
      if (match) {
        req.session.user = { id: user.id, username: user.username };
        res.redirect('/dashboard');
      } else {
        res.redirect('/login?error=Invalid');
      }
    });
  });
});

// Create Tournament
app.post('/tournament/create', auth, (req, res) => {
  const { name } = req.body;
  db.run(`INSERT INTO tournaments (name, createdBy) VALUES (?, ?)`, [name, req.session.user.username], function(err) {
    const tid = this.lastID;
    db.run(`INSERT INTO tournament_players (tournament_id, user_id) VALUES (?, ?)`, [tid, req.session.user.id]);
    res.redirect('/dashboard');
  });
});

// Join Tournament
app.post('/tournament/join/:id', auth, (req, res) => {
  const tid = req.params.id;
  db.run(`INSERT OR IGNORE INTO tournament_players (tournament_id, user_id) VALUES (?, ?)`, [tid, req.session.user.id]);
  res.redirect('/tournament/' + tid);
});

// Generate Fixtures
app.post('/tournament/generate/:id', auth, (req, res) => {
  const tid = req.params.id;
  db.all(`SELECT u.username FROM users u JOIN tournament_players tp ON u.id = tp.user_id WHERE tp.tournament_id = ?`, [tid], (err, rows) => {
    const players = rows.map(r => r.username);
    if (players.length < 2) return res.redirect('/tournament/' + tid);

    db.run(`DELETE FROM fixtures WHERE tournament_id = ?`, [tid]);
    db.run(`DELETE FROM standings WHERE tournament_id = ?`, [tid]);

    const stmtFixture = db.prepare(`INSERT INTO fixtures (tournament_id, home, away) VALUES (?, ?, ?)`);
    const stmtStanding = db.prepare(`INSERT INTO standings (tournament_id, player) VALUES (?, ?)`);

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        stmtFixture.run(tid, players[i], players[j]);
        stmtFixture.run(tid, players[j], players[i]);
      }
      stmtStanding.run(tid, players[i]);
    }
    stmtFixture.finalize();
    stmtStanding.finalize();
    res.redirect('/tournament/' + tid);
  });
});

// Update Score
app.post('/tournament/score/:id', auth, (req, res) => {
  const tid = req.params.id;
  const { homeScore, awayScore, fixtureIndex } = req.body;

  db.all(`SELECT * FROM fixtures WHERE tournament_id = ?`, [tid], (err, fixtures) => {
    const f = fixtures[fixtureIndex];
    db.run(`UPDATE fixtures SET homeScore = ?, awayScore = ?, played = 1 WHERE id = ?`, [homeScore, awayScore, f.id], () => {

      db.get(`SELECT * FROM standings WHERE tournament_id = ? AND player = ?`, [tid, f.home], (err, home) => {
        db.get(`SELECT * FROM standings WHERE tournament_id = ? AND player = ?`, [tid, f.away], (err, away) => {
          updateStanding(home, parseInt(homeScore), parseInt(awayScore));
          updateStanding(away, parseInt(awayScore), parseInt(homeScore));
          res.redirect('/tournament/' + tid);
        });
      });
    });
  });

  function updateStanding(row, gf, ga) {
    const played = row.played + 1;
    const won = row.won + (gf > ga ? 1 : 0);
    const drawn = row.drawn + (gf === ga ? 1 : 0);
    const lost = row.lost + (gf < ga ? 1 : 0);
    const points = won * 3 + drawn;
    const gd = (row.gf + gf) - (row.ga + ga);

    db.run(`UPDATE standings SET 
      played = ?, won = ?, drawn = ?, lost = ?, gf = gf + ?, ga = ga + ?, gd = ?, points = ?
      WHERE tournament_id = ? AND player = ?`,
      [played, won, drawn, lost, gf, ga, gd, points, tid, row.player]);
  }
});

// Auth
function auth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

app.listen(PORT, () => console.log(`eFootball Freaks LIVE on port ${PORT}`));