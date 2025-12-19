const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();

// Laad vragen uit questions.json
function loadQuestionsFromFile() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    const parsed = JSON.parse(data);
    return parsed.categories || [];
  } catch (err) {
    console.log('Geen questions.json gevonden of fout bij laden:', err.message);
    return [];
  }
}

// Kapitaliseer naam (martijn -> Martijn, jan-willem -> Jan-Willem)
function capitalizeName(name) {
  return name
    .toLowerCase()
    .split(/(\s+|-)/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// Normaliseer tekst voor vergelijking (lowercase, strip accenten, extra spaties)
function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accenten
    .replace(/\s+/g, ' '); // normalize spaties
}

// Levenshtein distance - meet aantal bewerkingen om string A naar B te veranderen
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}

// Bepaal toegestane afstand op basis van woordlengte
function getAllowedDistance(wordLength) {
  if (wordLength <= 4) return 1;   // "film" → 1 typo
  if (wordLength <= 8) return 2;   // "flowers" → 2 typos
  return 3;                         // langere woorden → 3 typos
}

// Check of antwoord correct is (fuzzy matching)
function checkAnswer(playerAnswer, question) {
  const normalizedPlayer = normalizeText(playerAnswer);
  const questionType = question.type || 'text';

  if (questionType === 'multiple-choice') {
    // Exacte match voor MC (A, B, C, D)
    return normalizedPlayer === normalizeText(question.answer);
  }

  if (questionType === 'number') {
    // Nummer vergelijking met tolerantie
    const playerNum = parseFloat(normalizedPlayer.replace(/[^0-9.-]/g, ''));
    const correctNum = parseFloat(String(question.answer).replace(/[^0-9.-]/g, ''));
    const tolerance = question.tolerance || 0;

    if (!isNaN(playerNum) && !isNaN(correctNum)) {
      return Math.abs(playerNum - correctNum) <= tolerance;
    }
    return false;
  }

  // Text vragen: fuzzy matching
  const correctAnswer = normalizeText(question.answer);

  // 1. Exacte match
  if (normalizedPlayer === correctAnswer) return true;

  // 2. Levenshtein distance check (typefouten tolereren)
  const allowedDist = getAllowedDistance(correctAnswer.length);
  if (levenshtein(normalizedPlayer, correctAnswer) <= allowedDist) {
    return true;
  }

  // 3. Check acceptedAnswers array (alternatieve antwoorden)
  if (question.acceptedAnswers && Array.isArray(question.acceptedAnswers)) {
    for (const alt of question.acceptedAnswers) {
      const normalizedAlt = normalizeText(alt);
      // Exacte match met alternatief
      if (normalizedPlayer === normalizedAlt) return true;
      // Levenshtein voor alternatieven
      const altAllowedDist = getAllowedDistance(normalizedAlt.length);
      if (levenshtein(normalizedPlayer, normalizedAlt) <= altAllowedDist) return true;
      // Substring check voor alternatieven
      if (normalizedAlt.includes(normalizedPlayer) && normalizedPlayer.length >= 4) return true;
    }
  }

  // 4. Substring match (speler antwoord zit in correct antwoord)
  // Minimaal 4 karakters om valse positieven te voorkomen
  if (normalizedPlayer.length >= 4) {
    if (correctAnswer.includes(normalizedPlayer)) return true;
    if (normalizedPlayer.includes(correctAnswer)) return true;
  }

  return false;
}

// Zoek vragen voor een categorie (case-insensitive)
function findQuestionsForCategory(categoryName, allCategories) {
  const match = allCategories.find(c =>
    c.name.toLowerCase() === categoryName.toLowerCase()
  );
  if (match && match.questions) {
    // Voeg standaard type 'text' toe als er geen type is, behoud alle velden
    return match.questions.map(q => ({
      ...q,
      type: q.type || 'text',
      options: q.options || null,
      tolerance: q.tolerance || null,
      // Music-specific fields
      songTitle: q.songTitle || null,
      artist: q.artist || null,
      // Video-specific fields
      clipTitle: q.clipTitle || null,
      source: q.source || null,
      // Image-specific fields
      imageUrl: q.imageUrl || null,
      imageCredit: q.imageCredit || null,
      // Shared media fields
      youtubeId: q.youtubeId || null,
      playSeconds: q.playSeconds || 10
    }));
  }
  return [];
}

// Bepaal moeilijkheidsgraad van een vraag (1=makkelijk, 2=medium, 3=moeilijk)
function getQuestionDifficulty(question) {
  // Als expliciet ingesteld in questions.json, gebruik dat
  if (question.difficulty) {
    return question.difficulty;
  }
  // Anders, bepaal op basis van vraagtype
  const type = question.type || 'text';
  switch (type) {
    case 'multiple-choice': return 1; // Makkelijk - je ziet de opties
    case 'number': return 2;          // Medium - getal raden
    case 'music': return 2;           // Medium - song herkennen
    case 'video': return 2;           // Medium - filmquote herkennen
    case 'image': return 2;           // Medium - afbeelding herkennen
    case 'text': return 3;            // Moeilijk - open vraag
    default: return 2;
  }
}
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const VOTES_NEEDED_FOR_CATEGORY = 3;

// Game state
let gameState = {
  phase: 'lobby', // 'lobby' | 'category-voting' | 'playing' | 'finished'
  suggestedCategories: {}, // { categoryName: { votes: Set<playerName>, addedBy: playerName } }
  selectedCategories: [], // Categories that made it (3+ votes) with their questions
  currentCategoryIndex: 0,
  currentQuestionIndex: -1,
  showAnswer: false,
  players: {}, // { playerName: { answers: {}, score: 0, bets: Set } }
  skipVotes: new Set(),
  quizStarted: false,
  correctPlayers: new Set() // Players who got current question correct
};

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Routes
app.get('/quiz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quiz.html'));
});

app.get('/quiz/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/quiz/start', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'start.html'));
});

app.get('/quiz/:playerName', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// API endpoints
app.get('/api/state', (req, res) => {
  res.json(getPublicGameState());
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state to new connection
  socket.emit('gameState', getPublicGameState());
  socket.emit('playerUpdate', getPlayersWithScores());
  socket.emit('categoryVotesUpdate', getCategoryVotesPublic());

  // Player joins
  socket.on('playerJoin', (rawName) => {
    const playerName = capitalizeName(rawName);
    if (!gameState.players[playerName]) {
      gameState.players[playerName] = {
        answers: {},
        score: 0,
        bets: new Set()
      };
    }
    socket.playerName = playerName;
    // Stuur gekapitaliseerde naam terug naar client
    socket.emit('nameUpdated', playerName);
    console.log(`Player joined: ${playerName}`);
    io.emit('playerUpdate', getPlayersWithScores());
    io.emit('skipVoteUpdate', getSkipVoteStatus());
  });

  // === CATEGORY VOTING PHASE ===

  // Player suggests a category - if 3 people suggest the same, it auto-adds
  socket.on('suggestCategory', ({ playerName, categoryName }) => {
    if (gameState.phase !== 'category-voting') return;
    if (!categoryName || categoryName.trim().length === 0) return;

    const normalizedName = categoryName.trim();

    // Check if category already exists (case-insensitive)
    const existingKey = Object.keys(gameState.suggestedCategories)
      .find(key => key.toLowerCase() === normalizedName.toLowerCase());

    if (existingKey) {
      // Add this player to existing category
      gameState.suggestedCategories[existingKey].suggesters.add(playerName);
      console.log(`${playerName} also wants: ${existingKey}`);
    } else {
      // Create new category
      gameState.suggestedCategories[normalizedName] = {
        suggesters: new Set([playerName]),
        questions: []
      };
      console.log(`${playerName} suggested: ${normalizedName}`);
    }

    io.emit('categoryVotesUpdate', getCategoryVotesPublic());
    checkCategoryThreshold();
  });

  // Admin adds a question to a category
  socket.on('addQuestion', ({ categoryName, question, answer }) => {
    // Find category in selected or suggested
    let category = gameState.selectedCategories.find(c => c.name === categoryName);
    if (!category && gameState.suggestedCategories[categoryName]) {
      category = gameState.suggestedCategories[categoryName];
    }

    if (category) {
      const questionId = Date.now() + Math.random();
      category.questions.push({ id: questionId, question, answer });
      console.log(`Added question to ${categoryName}: ${question}`);
      io.emit('categoryVotesUpdate', getCategoryVotesPublic());
      io.emit('gameState', getPublicGameState());
    }
  });

  // === PHASE CONTROLS ===

  // Admin starts category voting phase
  socket.on('startCategoryVoting', () => {
    gameState.phase = 'category-voting';
    gameState.suggestedCategories = {};
    gameState.selectedCategories = [];
    io.emit('gameState', getPublicGameState());
    io.emit('categoryVotesUpdate', getCategoryVotesPublic());
    console.log('Category voting started!');
  });

  // Admin starts the quiz (locks in categories)
  socket.on('startQuiz', () => {
    // Laad vragen uit questions.json
    const fileCategories = loadQuestionsFromFile();

    // Get all categories with 3+ suggesters
    const qualifiedCategories = Object.entries(gameState.suggestedCategories)
      .filter(([_, data]) => data.suggesters.size >= VOTES_NEEDED_FOR_CATEGORY)
      .map(([name, data]) => {
        // Probeer vragen uit file te laden als er nog geen zijn
        let questions = data.questions;
        if (questions.length === 0) {
          questions = findQuestionsForCategory(name, fileCategories);
          if (questions.length > 0) {
            console.log(`Loaded ${questions.length} questions for "${name}" from questions.json`);
          }
        }
        return {
          name,
          questions,
          suggesters: Array.from(data.suggesters)
        };
      });

    if (qualifiedCategories.length === 0) {
      socket.emit('error', { message: 'Geen categorieën met 3+ stemmen!' });
      return;
    }

    // Filter out categories without questions
    const categoriesWithQuestions = qualifiedCategories.filter(c => c.questions.length > 0);

    if (categoriesWithQuestions.length === 0) {
      socket.emit('error', { message: 'Geen categorieën met vragen! Voeg vragen toe in questions.json.' });
      return;
    }

    // Sort by most votes first
    categoriesWithQuestions.sort((a, b) => b.suggesters.length - a.suggesters.length);

    // Sort questions by difficulty (easy to hard)
    categoriesWithQuestions.forEach(category => {
      category.questions.sort((a, b) => {
        const diffA = getQuestionDifficulty(a);
        const diffB = getQuestionDifficulty(b);
        return diffA - diffB;
      });
    });

    gameState.selectedCategories = categoriesWithQuestions;
    gameState.phase = 'playing';
    gameState.quizStarted = true;
    gameState.currentCategoryIndex = 0;
    gameState.currentQuestionIndex = 0;
    gameState.showAnswer = false;
    gameState.skipVotes = new Set();

    io.emit('gameState', getPublicGameState());
    io.emit('skipVoteUpdate', getSkipVoteStatus());
    console.log(`Quiz started with ${gameState.selectedCategories.length} categories!`);
  });

  // === PLAYING PHASE ===

  // Player submits answer
  socket.on('submitAnswer', ({ playerName, questionId, answer }) => {
    if (gameState.players[playerName]) {
      gameState.players[playerName].answers[questionId] = answer;
      console.log(`${playerName} answered Q${questionId}: ${answer}`);
      io.emit('answerSubmitted', { playerName, questionId });
      io.emit('playerUpdate', getPlayersWithScores());
    }
  });

  // Player places a bet on the NEXT question (blind bet)
  socket.on('placeBet', ({ playerName }) => {
    if (gameState.players[playerName] && gameState.currentQuestionIndex >= 0) {
      const category = gameState.selectedCategories[gameState.currentCategoryIndex];
      const nextQuestionIndex = gameState.currentQuestionIndex + 1;
      const nextQuestion = category?.questions[nextQuestionIndex];
      if (nextQuestion) {
        gameState.players[playerName].bets.add(nextQuestion.id);
        console.log(`${playerName} placed a BLIND bet on next question (Q${nextQuestion.id})`);
        io.emit('playerUpdate', getPlayersWithScores());
        socket.emit('betPlaced', { questionId: nextQuestion.id });
      }
    }
  });

  // Player votes to skip category
  socket.on('voteSkipCategory', ({ playerName }) => {
    console.log(`Skip vote attempt from: ${playerName}, phase: ${gameState.phase}, known player: ${!!gameState.players[playerName]}`);
    if (gameState.players[playerName] && gameState.phase === 'playing') {
      gameState.skipVotes.add(playerName);
      console.log(`${playerName} voted to skip category`);

      const skipStatus = getSkipVoteStatus();
      console.log(`Skip status: ${skipStatus.skipVoteCount}/${skipStatus.votesNeeded}, shouldSkip: ${skipStatus.shouldSkip}`);
      io.emit('skipVoteUpdate', skipStatus);

      if (skipStatus.shouldSkip) {
        console.log('Skipping to next category!');
        skipToNextCategory();
      }
    }
  });

  socket.on('removeSkipVote', ({ playerName }) => {
    if (gameState.players[playerName]) {
      gameState.skipVotes.delete(playerName);
      io.emit('skipVoteUpdate', getSkipVoteStatus());
    }
  });

  // Admin controls
  socket.on('nextQuestion', () => {
    const category = gameState.selectedCategories[gameState.currentCategoryIndex];
    if (!category) return;

    if (gameState.currentQuestionIndex < category.questions.length - 1) {
      gameState.currentQuestionIndex++;
      gameState.showAnswer = false;
      io.emit('gameState', getPublicGameState());
    } else {
      skipToNextCategory();
    }
  });

  socket.on('prevQuestion', () => {
    if (gameState.currentQuestionIndex > 0) {
      gameState.currentQuestionIndex--;
      gameState.showAnswer = false;
      io.emit('gameState', getPublicGameState());
    }
  });

  socket.on('nextCategory', () => {
    skipToNextCategory();
  });

  socket.on('toggleAnswer', () => {
    const wasHidden = !gameState.showAnswer;
    gameState.showAnswer = !gameState.showAnswer;

    // Reset correct tracking when hiding answer
    if (!gameState.showAnswer) {
      gameState.correctPlayers = new Set();
    }

    // Auto-scoring bij het tonen van het antwoord (alle vraagtypes)
    if (gameState.showAnswer && wasHidden) {
      const category = gameState.selectedCategories[gameState.currentCategoryIndex];
      const question = category?.questions[gameState.currentQuestionIndex];

      gameState.correctPlayers = new Set();

      if (question) {
        Object.entries(gameState.players).forEach(([playerName, player]) => {
          const playerAnswer = player.answers[question.id];
          if (!playerAnswer) return; // Geen antwoord gegeven

          const isCorrect = checkAnswer(playerAnswer, question);
          const hasBet = player.bets.has(question.id);

          if (isCorrect) {
            player.score += hasBet ? 2 : 1;
            gameState.correctPlayers.add(playerName);
            console.log(`✓ ${playerName} correct! +${hasBet ? 2 : 1} punt(en)`);
          } else if (hasBet) {
            player.score -= 1;
            console.log(`✗ ${playerName} fout met bet, -1 punt`);
          }
        });

        io.emit('playerUpdate', getPlayersWithScores());
      }
    }

    io.emit('gameState', getPublicGameState());
  });

  socket.on('updateScore', ({ playerName, score }) => {
    if (gameState.players[playerName]) {
      gameState.players[playerName].score = score;
      io.emit('playerUpdate', getPlayersWithScores());
    }
  });

  socket.on('awardPoints', ({ playerName, points, questionId }) => {
    if (gameState.players[playerName]) {
      const player = gameState.players[playerName];
      const hasBet = player.bets.has(questionId);
      let actualPoints = hasBet ? points * 2 : points;
      player.score += actualPoints;
      io.emit('playerUpdate', getPlayersWithScores());
    }
  });

  socket.on('deductBetPoints', ({ playerName, points, questionId }) => {
    if (gameState.players[playerName]) {
      const player = gameState.players[playerName];
      if (player.bets.has(questionId)) {
        player.score -= points;
        io.emit('playerUpdate', getPlayersWithScores());
      }
    }
  });

  socket.on('resetQuiz', () => {
    gameState = {
      phase: 'lobby',
      suggestedCategories: {},
      selectedCategories: [],
      currentCategoryIndex: 0,
      currentQuestionIndex: -1,
      showAnswer: false,
      players: {},
      skipVotes: new Set(),
      quizStarted: false,
      correctPlayers: new Set()
    };
    io.emit('gameState', getPublicGameState());
    io.emit('playerUpdate', []);
    io.emit('skipVoteUpdate', getSkipVoteStatus());
    io.emit('categoryVotesUpdate', getCategoryVotesPublic());
    console.log('Quiz reset!');
  });

  // Refresh questions from file (re-broadcast category data)
  socket.on('refreshQuestions', () => {
    console.log('Refreshing questions from questions.json...');
    io.emit('categoryVotesUpdate', getCategoryVotesPublic());
    io.emit('gameState', getPublicGameState());
  });

  socket.on('disconnect', () => {
    if (socket.playerName) {
      gameState.skipVotes.delete(socket.playerName);
      io.emit('skipVoteUpdate', getSkipVoteStatus());
    }
    console.log('Client disconnected:', socket.id);
  });
});

function checkCategoryThreshold() {
  // Check if any category just reached the threshold
  Object.entries(gameState.suggestedCategories).forEach(([name, data]) => {
    if (data.suggesters.size === VOTES_NEEDED_FOR_CATEGORY) {
      console.log(`Category "${name}" reached ${VOTES_NEEDED_FOR_CATEGORY} people - AUTO ADDED!`);
      io.emit('categoryApproved', { categoryName: name });
    }
  });
}

function skipToNextCategory() {
  if (gameState.currentCategoryIndex < gameState.selectedCategories.length - 1) {
    gameState.currentCategoryIndex++;
    gameState.currentQuestionIndex = 0;
    gameState.showAnswer = false;
    gameState.skipVotes = new Set();
    io.emit('gameState', getPublicGameState());
    io.emit('skipVoteUpdate', getSkipVoteStatus());
  } else {
    gameState.phase = 'finished';
    gameState.currentQuestionIndex = -1;
    io.emit('gameState', getPublicGameState());
    console.log('Quiz finished!');
  }
}

function getSkipVoteStatus() {
  const totalPlayers = Object.keys(gameState.players).length;
  const skipVoteCount = gameState.skipVotes.size;
  const votesNeeded = Math.floor(totalPlayers / 2) + 1;

  // Bereken minimum vragen op basis van stemmen voor deze categorie
  // 3 stemmen → 1 vraag, 4 → 2, 5 → 3, 6 → 4, 7+ → 5
  const category = gameState.selectedCategories[gameState.currentCategoryIndex];
  const categoryVotes = category?.suggesters?.length || 3;
  const mandatoryQuestions = Math.min(categoryVotes - 2, 5);
  const questionsAnswered = gameState.currentQuestionIndex + 1;
  const canSkipYet = questionsAnswered >= mandatoryQuestions;

  return {
    skipVoteCount,
    totalPlayers,
    votesNeeded,
    mandatoryQuestions,
    questionsAnswered,
    canSkipYet,
    shouldSkip: totalPlayers > 0 && skipVoteCount >= votesNeeded && canSkipYet,
    voters: Array.from(gameState.skipVotes)
  };
}

function getCategoryVotesPublic() {
  // Laad vragen uit file om actuele counts te tonen
  const fileCategories = loadQuestionsFromFile();

  return Object.entries(gameState.suggestedCategories).map(([name, data]) => {
    // Check eerst in-memory vragen, dan file
    let questionCount = data.questions.length;
    if (questionCount === 0) {
      const fileQuestions = findQuestionsForCategory(name, fileCategories);
      questionCount = fileQuestions.length;
    }

    return {
      name,
      suggesterCount: data.suggesters.size,
      suggesters: Array.from(data.suggesters),
      isApproved: data.suggesters.size >= VOTES_NEEDED_FOR_CATEGORY,
      questionCount
    };
  }).sort((a, b) => b.suggesterCount - a.suggesterCount);
}

function getPublicGameState() {
  const category = gameState.selectedCategories[gameState.currentCategoryIndex];
  const question = category && gameState.currentQuestionIndex >= 0
    ? category.questions[gameState.currentQuestionIndex]
    : null;

  return {
    phase: gameState.phase,
    currentCategoryIndex: gameState.currentCategoryIndex,
    currentCategory: category ? {
      name: category.name,
      questionCount: category.questions.length,
      suggesters: category.suggesters
    } : null,
    currentQuestionIndex: gameState.currentQuestionIndex,
    currentQuestion: question ? {
      id: question.id,
      type: question.type || 'text',
      question: question.question,
      options: question.options || null,
      tolerance: question.tolerance || null,
      answer: gameState.showAnswer ? question.answer : null,
      // Music-specific fields (always sent, admin needs them to play)
      songTitle: question.songTitle || null,
      artist: question.artist || null,
      // Video-specific fields
      clipTitle: question.clipTitle || null,
      source: question.source || null,
      // Image-specific fields
      imageUrl: question.imageUrl || null,
      imageCredit: question.imageCredit || null,
      // Shared media fields
      youtubeId: question.youtubeId || null,
      playSeconds: question.playSeconds || 10
    } : null,
    showAnswer: gameState.showAnswer,
    totalCategories: gameState.selectedCategories.length,
    quizStarted: gameState.quizStarted,
    isFinished: gameState.phase === 'finished',
    votesNeededForCategory: VOTES_NEEDED_FOR_CATEGORY,
    approvedCategoryCount: Object.values(gameState.suggestedCategories)
      .filter(c => c.suggesters.size >= VOTES_NEEDED_FOR_CATEGORY).length
  };
}

function getPlayersWithScores() {
  const category = gameState.selectedCategories[gameState.currentCategoryIndex];
  const currentQuestion = category && gameState.currentQuestionIndex >= 0
    ? category.questions[gameState.currentQuestionIndex]
    : null;

  return Object.entries(gameState.players).map(([name, data]) => ({
    name,
    score: data.score,
    answeredCount: Object.keys(data.answers).length,
    currentAnswer: currentQuestion ? data.answers[currentQuestion.id] : null,
    hasBetOnCurrent: currentQuestion ? data.bets.has(currentQuestion.id) : false,
    hasVotedSkip: gameState.skipVotes.has(name),
    wasCorrect: gameState.correctPlayers.has(name) && gameState.showAnswer
  })).sort((a, b) => b.score - a.score);
}

server.listen(PORT, () => {
  console.log(`Pub Quiz server running on http://localhost:${PORT}`);
  console.log(`  Quiz display: http://localhost:${PORT}/quiz`);
  console.log(`  Admin panel:  http://localhost:${PORT}/quiz/admin`);
  console.log(`  Player join:  http://localhost:${PORT}/quiz/{name}`);
  console.log(`\n  Categories need ${VOTES_NEEDED_FOR_CATEGORY} votes to be included in the quiz.`);
});
