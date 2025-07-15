require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3094;

// PostgreSQL connection with retry logic
const poolConfig = {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'new_employee_db',
  password: process.env.DB_PASSWORD || 'admin123',
  port: process.env.DB_PORT || 5432,
};

const createPoolWithRetry = () => {
  const pool = new Pool(poolConfig);
  
  // Test the connection
  pool.query('SELECT 1')
    .then(() => console.log('Connected to PostgreSQL'))
    .catch(async (err) => {
      console.error('Failed to connect to PostgreSQL:', err.message);
      console.log('Retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      return createPoolWithRetry();
    });
  
  return pool;
};

const pool = createPoolWithRetry();

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'Uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const uploadDir = path.join(__dirname, 'Uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (!file) {
      return cb(null, true);
    }
    const filetypes = /pdf|jpg|jpeg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed'));
  },
});

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    "http://13.60.223.220:3094",
    "http://127.0.0.1:5500",
    "http://13.60.223.220:5500",
    "http://127.0.0.1:5501",
    "http://127.0.0.1:5503",
    "http://13.60.223.220:8157",
    "http://13.60.223.220:8158",
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/Uploads', express.static(path.join(__dirname, 'Uploads')));

// Route to handle file downloads
app.get('/download/:filename', (req, res) => {
  let filename = req.params.filename;
  // Normalize filename to handle both forward and backslashes
  filename = filename.replace(/\\/g, '/').split('/').pop();
  const filePath = path.join(__dirname, 'Uploads', filename);
  console.log('Requested file path:', filePath);

  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      console.error('File access error:', err);
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('Error sending file:', err);
        return res.status(500).json({ error: 'Error downloading file', details: err.message });
      }
      console.log(`File ${filename} sent successfully`);
    });
  });
});

// Create requests table if not exists
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

// Initialize the database
initializeDatabase();

// API Routes

// Create a new request
app.post('/api/requests', upload.single('document'), async (req, res) => {
  try {
    const { name, email, empId, program, program_time, date, reason, loan_type, amount } = req.body;
    const documentPath = req.file ? `Uploads/${req.file.filename}` : null;

    // Check for duplicate request for one-time programs
    const oneTimePrograms = [
      'Yoga and Meditation',
      'Mental Health Support',
      'Awareness Programs',
      'Health Checkup Camps',
      'Gym Membership',
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
        name, email, emp_id, program, program_time, request_date, status, loan_type, amount, reason, document_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [name, email, empId, program, program_time || null, date, 'Pending', loan_type || null, amount || null, reason || null, documentPath]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating request:', err);
    res.status(500).json({ error: 'Failed to create request', details: err.message });
  }
});

// Get all requests
app.get('/api/requests', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM requests ORDER BY request_date DESC');
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
    const result = await pool.query('SELECT * FROM requests WHERE emp_id = $1 ORDER BY request_date DESC', [empId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching requests by empId:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Update request status
app.put('/api/requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const result = await pool.query(
      'UPDATE requests SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
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

// Start server
app.listen(port, () => {
  console.log(`Server running on http://13.60.223.220:${port}`);
});

process.on('SIGINT', () => {
  pool.end();
  process.exit();
});
