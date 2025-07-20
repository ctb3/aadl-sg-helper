import { useRef, useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
// @ts-ignore - Static import of Scribe.js
import scribe from 'scribe.js-ocr';
import { apiService } from './services/apiService';

// Type declarations for Scribe.js results (unused but kept for reference)
// interface ScribeResult {
//   text: string;
//   confidence?: number;
//   boundingBox?: any;
// }

function App() {
  const [image, setImage] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);
  const [showCropper, setShowCropper] = useState(false);
  
  // AADL Login state
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [debugMode, setDebugMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionMessages, setSubmissionMessages] = useState<Array<{
    text: string;
    type: 'success' | 'error' | 'warning' | 'info';
  }>>([]);
  
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scribeInitialized = useRef(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setImage(ev.target?.result as string);
        setOcrResult('');
        setShowCropper(true);
        setZoom(1);
        setCrop({ x: 0, y: 0 });
      };
      reader.readAsDataURL(file);
    }
  };

  const onCropComplete = useCallback((_croppedArea: any, croppedAreaPixels: any) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const handleCrop = async () => {
    if (!image || !croppedAreaPixels || !canvasRef.current) return;
    
    setLoading(true);
    setOcrResult('');
    
    try {
      const canvas = canvasRef.current;
      const imageElement = new Image();
      
      imageElement.onload = async () => {
        canvas.width = croppedAreaPixels.width;
        canvas.height = croppedAreaPixels.height;
        const ctx = canvas.getContext('2d')!;
        
        ctx.drawImage(
          imageElement,
          croppedAreaPixels.x,
          croppedAreaPixels.y,
          croppedAreaPixels.width,
          croppedAreaPixels.height,
          0,
          0,
          croppedAreaPixels.width,
          croppedAreaPixels.height
        );
        
        // Enhance the image for better OCR
        const enhancedCanvas = document.createElement('canvas');
        enhancedCanvas.width = canvas.width;
        enhancedCanvas.height = canvas.height;
        const enhancedCtx = enhancedCanvas.getContext('2d')!;
        
        // Draw the original image
        enhancedCtx.drawImage(canvas, 0, 0);
        
        // Apply image enhancement for better OCR
        const imageData = enhancedCtx.getImageData(0, 0, enhancedCanvas.width, enhancedCanvas.height);
        const data = imageData.data;
        
                  // Increase contrast and emphasize larger text
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            
            // Convert to grayscale and enhance contrast
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            // Use adaptive thresholding to emphasize larger text
            const enhanced = gray > 150 ? 255 : (gray < 80 ? 0 : gray);
            
            data[i] = enhanced;     // R
            data[i + 1] = enhanced; // G
            data[i + 2] = enhanced; // B
            // Alpha stays the same
          }
        
        enhancedCtx.putImageData(imageData, 0, 0);
        
        // Run OCR on the enhanced canvas using Scribe.js
        const dataUrl = enhancedCanvas.toDataURL('image/png');
        
        try {
          console.log('Starting Scribe.js OCR...');
          console.log('Scribe loaded:', scribe);
          
          // Initialize Scribe.js if not already initialized
          if (!scribeInitialized.current) {
            await scribe.init({ ocr: true, font: true });
            scribeInitialized.current = true;
            console.log('Scribe initialized');
          }
          
          // Convert data URL to blob and create a File object with a name
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const file = new File([blob], 'cropped-image.png', { type: 'image/png' });
          
          // Try different Scribe.js methods
          console.log('Available Scribe methods:', Object.keys(scribe));
          
          let result;
          try {
            // Try different parameter combinations for extractText using File object
            console.log('Trying extractText with file array and language...');
            result = await scribe.extractText([file], ['eng'], 'txt');
            console.log('extractText result:', result);
          } catch (extractError) {
            console.log('First attempt failed:', extractError);
            
            try {
              // Try with different language settings for handwriting
              console.log('Trying extractText with handwriting-optimized settings...');
              result = await scribe.extractText([file], ['eng'], 'txt');
              console.log('extractText result (handwriting optimized):', result);
            } catch (extractError2) {
              console.log('Second attempt failed:', extractError2);
              
              try {
                // Try with file array but no language or format
                console.log('Trying extractText with file array only...');
                result = await scribe.extractText([file]);
                console.log('extractText result (file array only):', result);
              } catch (extractError3) {
                console.log('Third attempt failed:', extractError3);
                throw new Error('All extractText attempts failed');
              }
            }
          }
          
          console.log('Final result:', result);
          console.log('Result type:', typeof result);
          
          // Process the result based on its type
          let bestResult = '';
          console.log('Processing result:', result);
          
          if (result) {
            if (typeof result === 'string') {
              // String result - split by lines and filter for larger text
              const lines = result.split('\n').filter(line => line.trim().length > 0);
              
              // Filter out small text and common printed text patterns
              const validResults = lines
                .filter(line => {
                  const cleanLine = line.trim();
                  // Prefer longer lines (likely larger text)
                  const isLongEnough = cleanLine.length >= 4 && cleanLine.length <= 15;
                  // Filter out common printed text patterns
                  const isNotPrintedText = !cleanLine.toLowerCase().includes('play') &&
                                         !cleanLine.toLowerCase().includes('aadl') &&
                                         !cleanLine.toLowerCase().includes('org') &&
                                         !cleanLine.toLowerCase().includes('write') &&
                                         !cleanLine.toLowerCase().includes('your') &&
                                         !cleanLine.toLowerCase().includes('code') &&
                                         !cleanLine.toLowerCase().includes('space');
                  return isLongEnough && isNotPrintedText;
                })
                .sort((a, b) => b.length - a.length); // Prefer longer text (likely larger)
              
              console.log('Valid results:', validResults);
              
              if (validResults.length > 0) {
                bestResult = validResults[0];
              } else if (lines.length > 0) {
                // Fallback to the longest line that's not obviously printed text
                const fallbackLines = lines
                  .filter(line => !line.toLowerCase().includes('play') && 
                                !line.toLowerCase().includes('aadl'))
                  .sort((a, b) => b.length - a.length);
                bestResult = fallbackLines.length > 0 ? fallbackLines[0] : lines[0];
              }
            } else if (typeof result === 'object') {
              // Object result - try to extract text from various properties
              console.log('Result object keys:', Object.keys(result));
              
              // Try common property names for text
              const textProperties = ['text', 'content', 'data', 'result', 'ocr', 'words'];
              for (const prop of textProperties) {
                if (result[prop] && typeof result[prop] === 'string') {
                  bestResult = result[prop];
                  console.log(`Found text in property '${prop}':`, bestResult);
                  break;
                }
              }
              
              // If no text found in common properties, try to stringify the object
              if (!bestResult) {
                bestResult = JSON.stringify(result);
                console.log('Using stringified object as result:', bestResult);
              }
            }
          }
          
          console.log('Final result:', bestResult);
          
          // Post-process common OCR mistakes
          let processedResult = bestResult.trim();
          if (processedResult) {
            // Fix common OCR mistakes
            processedResult = processedResult
              // .replace(/\\l/g, 'V')   // Fix "\l" -> "V" (backslash + lowercase L)
              // .replace(/\\I/g, 'V')   // Fix "\I" -> "V" (backslash + uppercase I)
              // .replace(/\\i/g, 'V')   // Fix "\i" -> "V" (backslash + lowercase i)
              // //.replace(/^ioutiful$/i, 'Vioutiful') // Fix the specific edge case
              // .replace(/['']/g, 't')  // Replace smart quotes with 't'
              // .replace(/[''`]/g, 't') // Replace various apostrophes with 't'
              // .replace(/['r]/g, 't')  // Fix the specific "Viou'riful" -> "Vioutiful" case
              // .replace(/['s]/g, 'ts') // Fix "it's" -> "its" cases
              .replace(/[^a-zA-Z0-9]/g, '') // Remove all non-alphanumeric characters
              .replace(/\s+/g, '')    // Remove all whitespace
              .substring(0, 12);      // Limit to 12 characters
            
            // Try to reconstruct common patterns if OCR missed parts
            
            
            console.log('Processed result:', processedResult);
          }
          
          setOcrResult(processedResult || 'No text detected');
        } catch (err) {
          console.error('Scribe.js error:', err);
          setOcrResult(`Error reading text: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
        
        setLoading(false);
      };
      
      imageElement.src = image;
    } catch (err) {
      console.error('Crop error:', err);
      setOcrResult('Error processing image');
      setLoading(false);
    }
  };

  const handleReset = () => {
    setImage(null);
    setOcrResult('');
    setShowCropper(false);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // AADL Login and submission functions
  const handleLogin = async () => {
    if (!username || !password) {
      setLoginError('Please enter both username and password');
      return;
    }

    setIsLoggingIn(true);
    setLoginError('');

    try {
      // Check if server is running
      const serverHealthy = await apiService.checkHealth();
      if (!serverHealthy) {
        setLoginError('Server is not running. Please start the backend server first.');
        return;
      }

      // Attempt login via API
      const response = await apiService.login(username, password, debugMode);
      
      if (response.success) {
        setIsLoggedIn(true);
        setLoginError('');
      } else {
        setLoginError(response.message || 'Login failed. Please check your credentials.');
      }
    } catch (error) {
      console.error('Login error:', error);
      setLoginError('Login failed. Please try again.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSubmitCode = async () => {
    if (!ocrResult || !isLoggedIn) {
      return;
    }

    setIsSubmitting(true);
    setSubmissionMessages([]); // Clear previous messages

    try {
      const response = await apiService.submitCode(ocrResult, debugMode);
      
      // Store the messages for display
      if (response.messages) {
        setSubmissionMessages(response.messages);
      }
      
      if (response.success) {
        // Clear the result after successful submission
        setOcrResult('');
      }
      
      // Don't show alert - let the messages display instead
    } catch (error) {
      console.error('Code submission error:', error);
      setSubmissionMessages([{
        text: 'Code submission failed. Please try again.',
        type: 'error'
      }]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiService.logout();
      setIsLoggedIn(false);
      setUsername('');
      setPassword('');
      setLoginError('');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 16 }}>
      <h2>Summer Game Code OCR</h2>
      
      {/* AADL Login Section */}
      {!isLoggedIn ? (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
          <h3 style={{ marginTop: 0 }}>AADL Login</h3>
          <p style={{ fontSize: 14, color: '#666', marginBottom: 16 }}>
            Login to automatically submit codes to the AADL Summer Game.
          </p>
          
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="username" style={{ display: 'block', marginBottom: 4 }}>Username or Email:</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
              placeholder="Enter your AADL username or email"
            />
          </div>
          
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="password" style={{ display: 'block', marginBottom: 4 }}>Password:</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
              placeholder="Enter your AADL password"
            />
          </div>
          
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={debugMode}
                onChange={(e) => setDebugMode(e.target.checked)}
              />
              Debug Mode (show browser window)
            </label>
          </div>
          
          {loginError && (
            <div style={{ color: 'red', marginBottom: 12, fontSize: 14 }}>
              {loginError}
            </div>
          )}
          
          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            style={{ 
              padding: '10px 20px', 
              backgroundColor: '#007bff', 
              color: 'white', 
              border: 'none', 
              borderRadius: '4px',
              cursor: isLoggingIn ? 'not-allowed' : 'pointer',
              opacity: isLoggingIn ? 0.6 : 1
            }}
          >
            {isLoggingIn ? 'Logging in...' : 'Login to AADL'}
          </button>
        </div>
      ) : (
        <div style={{ marginBottom: 24, padding: 12, border: '1px solid #28a745', borderRadius: '8px', backgroundColor: '#d4edda' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#155724', fontWeight: 'bold' }}>✓ Logged in to AADL</span>
            <button
              onClick={handleLogout}
              style={{ 
                padding: '6px 12px', 
                backgroundColor: '#dc3545', 
                color: 'white', 
                border: 'none', 
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              Logout
            </button>
          </div>
        </div>
      )}
      
      {!showCropper && (
        <div style={{ marginBottom: 16 }}>
          <input
            type="file"
            accept="image/*"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ marginBottom: 16 }}
          />
          <p style={{ fontSize: 14, color: '#666' }}>
            Upload a photo of the sign, then crop tightly around just the handwritten code (the white area with the handwritten text).
          </p>
        </div>
      )}

      {showCropper && image && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ position: 'relative', height: 400, marginBottom: 16 }}>
            <Cropper
              image={image}
              crop={crop}
              zoom={zoom}
              aspect={4 / 1}
              minZoom={0.1}
              maxZoom={10}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              style={{
                containerStyle: {
                  width: '100%',
                  height: '100%',
                  backgroundColor: '#f0f0f0',
                },
                cropAreaStyle: {
                  border: '2px solid #00ff00',
                  backgroundColor: 'rgba(0, 255, 0, 0.1)',
                },
              }}
            />
          </div>
          
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, fontSize: 12, color: '#666' }}>
              <strong>Instructions:</strong>
              <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>
                <li>Drag the green rectangle to position it over the handwritten text</li>
                <li>Pinch/scroll to zoom in (up to 10x zoom)</li>
                <li>Make sure only the handwritten text is inside the green box</li>
              </ul>
            </div>
            
            <button 
              onClick={handleCrop} 
              disabled={loading}
              style={{ marginRight: 8, padding: '8px 16px' }}
            >
              {loading ? 'Reading...' : 'Read Code'}
            </button>
            <button 
              onClick={handleReset}
              style={{ padding: '8px 16px' }}
            >
              Upload New Image
            </button>
          </div>
        </div>
      )}

      {ocrResult && (
        <div style={{ marginBottom: 16 }}>
          <label htmlFor="ocr-result">Code:</label>
          <input
            id="ocr-result"
            type="text"
            value={ocrResult}
            onChange={(e) => setOcrResult(e.target.value)}
            maxLength={12}
            placeholder="Edit the detected code if needed..."
            style={{ 
              width: '100%', 
              fontSize: 20, 
              textAlign: 'center', 
              marginTop: 4,
              padding: '8px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              backgroundColor: '#fff'
            }}
          />
          <p style={{ fontSize: 12, color: '#666', marginTop: 4, textAlign: 'center' }}>
            You can edit this text if the OCR didn't get it quite right. Max 12 characters, letters and numbers only.
          </p>
          
          {/* Submit to AADL button */}
          {isLoggedIn && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <button
                onClick={handleSubmitCode}
                disabled={isSubmitting || !ocrResult}
                style={{ 
                  padding: '12px 24px', 
                  backgroundColor: '#28a745', 
                  color: 'white', 
                  border: 'none', 
                  borderRadius: '8px',
                  cursor: (isSubmitting || !ocrResult) ? 'not-allowed' : 'pointer',
                  opacity: (isSubmitting || !ocrResult) ? 0.6 : 1,
                  fontSize: '16px',
                  fontWeight: 'bold'
                }}
              >
                {isSubmitting ? 'Submitting...' : 'Submit to AADL Summer Game'}
              </button>
              <p style={{ fontSize: '12px', color: '#666', marginTop: 4 }}>
                Automatically submits the code to your AADL Summer Game account.
              </p>
            </div>
          )}
          
          {/* Submission Messages */}
          {submissionMessages.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ marginBottom: 8, fontSize: '14px', fontWeight: 'bold' }}>
                Submission Results:
              </h4>
              {submissionMessages.map((message, index) => (
                <div
                  key={index}
                  style={{
                    padding: '12px',
                    marginBottom: 8,
                    borderRadius: '6px',
                    border: '1px solid',
                    backgroundColor: 
                      message.type === 'success' ? '#d4edda' :
                      message.type === 'error' ? '#f8d7da' :
                      message.type === 'warning' ? '#fff3cd' : '#d1ecf1',
                    borderColor:
                      message.type === 'success' ? '#c3e6cb' :
                      message.type === 'error' ? '#f5c6cb' :
                      message.type === 'warning' ? '#ffeaa7' : '#bee5eb',
                    color:
                      message.type === 'success' ? '#155724' :
                      message.type === 'error' ? '#721c24' :
                      message.type === 'warning' ? '#856404' : '#0c5460',
                    fontSize: '14px',
                    lineHeight: '1.4'
                  }}
                >
                  {message.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hidden canvas for cropping */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}

export default App;
