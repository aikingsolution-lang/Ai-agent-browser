import multer from 'multer';
import { AppError } from './errorHandler.js';

// Memory storage keeps file buffer directly in RAM (no temp disk writes)
const storage = multer.memoryStorage();

const allowedMimeTypes = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream', // Some browsers send binary stream for docs
];

const allowedExtensions = ['.pdf', '.doc', '.docx'];

export const uploadResume = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = '.' + (file.originalname.split('.').pop() || '').toLowerCase();
    const isAllowedExt = allowedExtensions.includes(ext);
    const isAllowedMime = allowedMimeTypes.includes(file.mimetype);

    if (isAllowedExt || isAllowedMime) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          'Invalid file format. Only PDF (.pdf) and Word documents (.doc, .docx) are supported.',
          400,
          'INVALID_FILE_FORMAT',
        ),
      );
    }
  },
});
