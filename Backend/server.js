require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3094;

// PostgreSQL connection with enhanced retry logic
const poolConfig = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'new_employee_db',
  password: process.env.DB_PASSWORD || 'admin123',
  port: process.env.DB_PORT || 5432,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 20
};

const createPoolWithRetry = async (attempt = 1) => {
  const pool = new Pool(poolConfig);
  
  try {
    await pool.query('SELECT 1');
    console.log('Successfully connected to PostgreSQL');
    return pool;
  } catch (err) {
    console.error(`Connection attempt ${attempt} failed:`, err.message);
    
    if (attempt >= 5) {
      console.error('Max connection attempts reached. Exiting...');
      process.exit(1);
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    return createPoolWithRetry(attempt + 1);
  }
};

const pool = createPoolWithRetry();

// Enhanced Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'Uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /pdf|jpg|jpeg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed'));
  }
});

// Enhanced CORS configuration
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://13.60.223.220:3094",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://13.60.223.220:5500",
  "http://127.0.0.1:5501",
  "http://127.0.0.1:5503",
  "http://13.60.223.220:8157",
  "http://13.60.223.220:8158"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files with cache control
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true
}));

app.use('/Uploads', express.static(path.join(__dirname, 'Uploads'), {
  maxAge: '7d',
  etag: true
}));

// Secure file download endpoint
app.get('/download/:filename', (req, res) => {
  const unsafeFilename = req.params.filename;
  
  // Validate filename to prevent directory traversal
  if (!/^[a-zA-Z0-9\-_]+(\.[a-zA-Z0-9]+)?$/.test(unsafeFilename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const safeFilename = path.basename(unsafeFilename);
  const filePath = path.join(__dirname, 'Uploads', safeFilename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.download(filePath, safeFilename, (err) => {
    if (err && !res.headersSent) {
      console.error('Download error:', err);
      res.status(500).json({ error: 'Error downloading file' });
    }
  });
});

// Database initialization
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        emp_id VARCHAR(50) NOT NULL,
        program VARCHAR(255) NOT NULL,
        program_time VARCHAR(255),
        request_date DATE NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Pending',
        loan_type VARCHAR(100),
        amount NUMERIC,
        reason TEXT,
        document_path VARCHAR(255)
      );
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('Database initialization failed:', err);
    process.exit(1);
  }
}

initializeDatabase();

// API Routes

// Create a new request
app.post('/api/requests', upload.single('document'), async (req, res) => {
  try {
    const { name, email, empId, program, program_time, date, reason, loan_type, amount } = req.body;
    const documentPath = req.file ? `Uploads/${req.file.filename}` : null;

    // Validate required fields
    if (!name || !email || !empId || !program || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check for duplicate request for one-time programs
    const oneTimePrograms = [
      'Yoga and Meditation',
      'Mental Health Support',
      'Awareness Programs',
      'Health Checkup Camps',
      'Gym Membership'
    ];
    
    if (oneTimePrograms.includes(program)) {
      const check = await pool.query(
        'SELECT * FROM requests WHERE emp_id = $1 AND program = $2 AND status != $3',
        [empId, program, 'Rejected']
      );
      if (check.rows.length) {
        return res.status(400).json({
          error: `You already have a ${check.rows[0].status.toLowerCase()} request for ${program}`,
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO requests (
        name, email, emp_id, program, program_time, request_date, status, 
        loan_type, amount, reason, document_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        name, email, empId, program, 
        program_time || null, 
        date, 
        'Pending', 
        loan_type || null, 
        amount || null, 
        reason || null, 
        documentPath
      ]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating request:', err);
    res.status(500).json({ 
      error: 'Failed to create request',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get all requests
app.get('/api/requests', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM requests 
      ORDER BY request_date DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching requests:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Get requests by employee ID
app.get('/api/requests/emp/:empId', async (req, res) => {
  try {
    const { empId } = req.params;
    const result = await pool.query(`
      SELECT * FROM requests 
      WHERE emp_id = $1 
      ORDER BY request_date DESC
    `, [empId]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching requests by empId:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Get single request by ID
app.get('/api/requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM requests 
      WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching request:', err);
    res.status(500).json({ error: 'Failed to fetch request' });
  }
});

// Update request status
app.put('/api/requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    
    const result = await pool.query(`
      UPDATE requests 
      SET status = $1 
      WHERE id = $2 
      RETURNING *
    `, [status, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating request:', err);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

// Serve HTML pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Frontend', 'index.html'));
});

app.get('/hr', (req, res) => {
  res.sendFile(path.join(__dirname, 'HR_page', 'index.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ 
      error: 'File upload error',
      details: err.message 
    });
  }
  
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS policy violation' });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://13.60.223.220:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    pool.end();
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    pool.end();
    console.log('Server closed');
    process.exit(0);
  });
});