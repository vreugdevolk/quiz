const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
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
  quizStarted: false
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
  socket.on('playerJoin', (playerName) => {
    if (!gameState.players[playerName]) {
      gameState.players[playerName] = {
        answers: {},
        score: 0,
        bets: new Set()
      };
    }
    socket.playerName = playerName;
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
    // Get all categories with 3+ suggesters
    const qualifiedCategories = Object.entries(gameState.suggestedCategories)
      .filter(([_, data]) => data.suggesters.size >= VOTES_NEEDED_FOR_CATEGORY)
      .map(([name, data]) => ({
        name,
        questions: data.questions,
        suggesters: Array.from(data.suggesters)
      }));

    if (qualifiedCategories.length === 0) {
      socket.emit('error', { message: 'Geen categorieën met 3+ stemmen!' });
      return;
    }

    // Filter out categories without questions
    const categoriesWithQuestions = qualifiedCategories.filter(c => c.questions.length > 0);

    if (categoriesWithQuestions.length === 0) {
      socket.emit('error', { message: 'Geen categorieën met vragen!' });
      return;
    }

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

  // Player places a bet
  socket.on('placeBet', ({ playerName }) => {
    if (gameState.players[playerName] && gameState.currentQuestionIndex >= 0) {
      const category = gameState.selectedCategories[gameState.currentCategoryIndex];
      const question = category?.questions[gameState.currentQuestionIndex];
      if (question && !gameState.showAnswer) {
        gameState.players[playerName].bets.add(question.id);
        console.log(`${playerName} placed a bet on Q${question.id}`);
        io.emit('playerUpdate', getPlayersWithScores());
        socket.emit('betPlaced', { questionId: question.id });
      }
    }
  });

  // Player votes to skip category
  socket.on('voteSkipCategory', ({ playerName }) => {
    if (gameState.players[playerName] && gameState.phase === 'playing') {
      gameState.skipVotes.add(playerName);
      console.log(`${playerName} voted to skip category`);

      const skipStatus = getSkipVoteStatus();
      io.emit('skipVoteUpdate', skipStatus);

      if (skipStatus.shouldSkip) {
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
    gameState.showAnswer = !gameState.showAnswer;
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
      quizStarted: false
    };
    io.emit('gameState', getPublicGameState());
    io.emit('playerUpdate', []);
    io.emit('skipVoteUpdate', getSkipVoteStatus());
    io.emit('categoryVotesUpdate', getCategoryVotesPublic());
    console.log('Quiz reset!');
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

  return {
    skipVoteCount,
    totalPlayers,
    votesNeeded,
    shouldSkip: totalPlayers > 0 && skipVoteCount >= votesNeeded,
    voters: Array.from(gameState.skipVotes)
  };
}

function getCategoryVotesPublic() {
  return Object.entries(gameState.suggestedCategories).map(([name, data]) => ({
    name,
    suggesterCount: data.suggesters.size,
    suggesters: Array.from(data.suggesters),
    isApproved: data.suggesters.size >= VOTES_NEEDED_FOR_CATEGORY,
    questionCount: data.questions.length
  })).sort((a, b) => b.suggesterCount - a.suggesterCount);
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
      question: question.question,
      answer: gameState.showAnswer ? question.answer : null
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
    hasVotedSkip: gameState.skipVotes.has(name)
  })).sort((a, b) => b.score - a.score);
}

server.listen(PORT, () => {
  console.log(`Pub Quiz server running on http://localhost:${PORT}`);
  console.log(`  Quiz display: http://localhost:${PORT}/quiz`);
  console.log(`  Admin panel:  http://localhost:${PORT}/quiz/admin`);
  console.log(`  Player join:  http://localhost:${PORT}/quiz/{name}`);
  console.log(`\n  Categories need ${VOTES_NEEDED_FOR_CATEGORY} votes to be included in the quiz.`);
});
