const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// CHANGE THIS PASSWORD!
const ADMIN_PASSWORD_HASH = crypto.createHash('sha256').update('your-secret-key-here').digest('hex');

const GAMEMODES = [
    'modern_smp', 'sword', 'diamond_pot', 'netherite_pot',
    'axe', 'modern_uhc', 'mace', 'crystal'
];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    const gamemodeColumns = GAMEMODES.map(mode => `${mode}_elo INTEGER DEFAULT 500`).join(', ');
    db.run(`CREATE TABLE IF NOT EXISTS player_ratings (
        username TEXT PRIMARY KEY, global_score INTEGER DEFAULT 500,
        ${gamemodeColumns}, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
        matches_played INTEGER DEFAULT 0, peak_rating INTEGER DEFAULT 500,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS match_history (
        id INTEGER PRIMARY KEY, winner TEXT, loser TEXT, gamemode TEXT,
        winner_elo_change INTEGER, loser_elo_change INTEGER,
        winner_new_elo INTEGER, loser_new_elo INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

let sseClients = [];

app.get('/api/leaderboard/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const clientId = Date.now();
    sseClients.push({ id: clientId, res });
    res.write(`data: ${JSON.stringify({type:'connected'})}\n\n`);
    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

function broadcastUpdate() {
    const msg = JSON.stringify({type:'update', time:Date.now()});
    sseClients.forEach(c => c.res.write(`data: ${msg}\n\n`));
}

function calcELO(winnerRating, loserRating, winnerScore, loserScore, ftType = 5, kFactor = 32) {
    const expectedW = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedL = 1 / (1 + Math.pow(10, (winnerRating - loserRating) / 400));
    
    let wChange = kFactor * (1 - expectedW);
    let lChange = kFactor * (0 - expectedL);
    
    // Score differential bonus (up to 50% more for dominant wins)
    const scoreDiff = winnerScore - loserScore;
    const totalScore = winnerScore + loserScore;
    const dominanceMultiplier = 1 + (scoreDiff / totalScore) * 0.5;
    
    // FT multiplier (longer matches = more impactful)
    const ftMultiplier = Math.sqrt(ftType / 5);
    
    wChange = Math.round(wChange * dominanceMultiplier * ftMultiplier);
    lChange = Math.round(lChange * ftMultiplier);
    
    return { winnerChange: wChange, loserChange: lChange };
}

app.post('/api/player/add', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({error:'Username required'});
    db.run(`INSERT OR IGNORE INTO player_ratings (username) VALUES (?)`, [username], function(err) {
        if (err) return res.status(500).json({error:err.message});
        res.json({success:true, message: this.changes>0?'Registered':'Exists', username});
    });
});

app.get('/api/leaderboard/global', (req, res) => {
    const cols = GAMEMODES.map(m=>`${m}_elo`).join(',');
    db.all(`SELECT username,global_score,${cols},wins,losses FROM player_ratings ORDER BY global_score DESC LIMIT 100`, [], (err,rows)=>{
        if (err) return res.status(500).json({error:err.message});
        res.json({leaderboard:rows});
    });
});

app.get('/api/leaderboard/:mode', (req, res) => {
    const mode = req.params.mode;
    if (!GAMEMODES.includes(mode)) return res.status(400).json({error:'Invalid'});
    db.all(`SELECT username,${mode}_elo as elo,wins,losses FROM player_ratings ORDER BY ${mode}_elo DESC LIMIT 100`, [], (err,rows)=>{
        if (err) return res.status(500).json({error:err.message});
        res.json({gamemode:mode, leaderboard:rows});
    });
});

app.post('/api/match/submit', async (req, res) => {
    const { winner, loser, gamemode } = req.body;
    if (!winner || !loser || !GAMEMODES.includes(gamemode)) {
        return res.status(400).json({error:'Invalid data'});
    }
    if (winner === loser) return res.status(400).json({error:'Same player'});

    try {
        const getP = (u) => new Promise((res,rej)=>{
            db.get(`SELECT * FROM player_ratings WHERE username=?`,[u],(err,row)=>{
                if(err) rej(err); else if(!row) rej(new Error(`Player ${u} not found`)); else res(row);
            });
        });

        const wData = await getP(winner);
        const lData = await getP(loser);
        const wRating = wData[`${gamemode}_elo`];
        const lRating = lData[`${gamemode}_elo`];
        const { winnerChange, loserChange } = calcELO(wRating, lRating);
        const wNew = wRating + winnerChange;
        const lNew = lRating + loserChange;

        await new Promise((res,rej)=>db.run(`UPDATE player_ratings SET ${gamemode}_elo=?,wins=wins+1,matches_played=matches_played+1 WHERE username=?`,[wNew,winner],err=>err?rej(err):res()));
        await new Promise((res,rej)=>db.run(`UPDATE player_ratings SET ${gamemode}_elo=?,losses=losses+1,matches_played=matches_played+1 WHERE username=?`,[lNew,loser],err=>err?rej(err):res()));

        const wSum = GAMEMODES.reduce((a,m)=>a+wData[`${m}_elo`],0)+winnerChange;
        const lSum = GAMEMODES.reduce((a,m)=>a+lData[`${m}_elo`],0)+loserChange;
        const wAvg = Math.round(wSum/GAMEMODES.length);
        const lAvg = Math.round(lSum/GAMEMODES.length);

        await new Promise((res,rej)=>db.run(`UPDATE player_ratings SET global_score=?,peak_rating=CASE WHEN ?>peak_rating THEN ? ELSE peak_rating END WHERE username=?`,[wAvg,wAvg,wAvg,winner],err=>err?rej(err):res()));
        await new Promise((res,rej)=>db.run(`UPDATE player_ratings SET global_score=?,peak_rating=CASE WHEN ?>peak_rating THEN ? ELSE peak_rating END WHERE username=?`,[lAvg,lAvg,lAvg,loser],err=>err?rej(err):res()));

        await new Promise((res,rej)=>db.run(`INSERT INTO match_history (winner,loser,gamemode,winner_elo_change,loser_elo_change,winner_new_elo,loser_new_elo) VALUES (?,?,?,?,?,?,?)`,[winner,loser,gamemode,winnerChange,loserChange,wNew,lNew],err=>err?rej(err):res()));

        broadcastUpdate();
        res.json({success:true, winner:{username:winner,old:wRating,new:wNew,change:winnerChange}, loser:{username:loser,old:lRating,new:lNew,change:loserChange}});
    } catch(e) {
        res.status(500).json({error:e.message});
    }
});

app.post('/admin/update_rating', (req, res) => {
    const { admin_key, username, gamemode, new_elo } = req.body;
    const hash = crypto.createHash('sha256').update(admin_key).digest('hex');
    if (hash !== ADMIN_PASSWORD_HASH) return res.status(401).json({error:'Invalid key'});

    const col = gamemode==='global'?'global_score':`${gamemode}_elo`;
    db.run(`UPDATE player_ratings SET ${col}=?,peak_rating=CASE WHEN ?>peak_rating THEN ? ELSE peak_rating END WHERE username=?`,[new_elo,new_elo,new_elo,username],function(err){
        if (err) return res.status(500).json({error:err.message});
        if (this.changes===0) return res.status(404).json({error:'Player not found'});
        broadcastUpdate();
        res.json({success:true,message:`Updated ${username} to ${new_elo}`});
    });
});

app.listen(PORT, () => {
    console.log(`Yungy's Ranking System on port ${PORT}`);
});