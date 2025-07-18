import { useRef, useState } from 'react';
import Tesseract from 'tesseract.js';
import codeAreaTemplate from './assets/code_area_template.png';
import signTemplate from './assets/sign_template.png';

function App() {
  const [image, setImage] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [opencvReady, setOpencvReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [croppedDataUrl, setCroppedDataUrl] = useState<string | null>(null);
  const [graySrcUrl, setGraySrcUrl] = useState<string | null>(null);
  const [grayTemplUrl, setGrayTemplUrl] = useState<string | null>(null);
  const [warpedDataUrl, setWarpedDataUrl] = useState<string | null>(null);
  const [codeAreaDataUrl, setCodeAreaDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugOverlayUrl, setDebugOverlayUrl] = useState<string | null>(null);

  // Wait for OpenCV.js to be ready
  if (typeof window !== 'undefined' && !opencvReady && (window as any).cv && (window as any).cv.Mat) {
    setOpencvReady(true);
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setImage(ev.target?.result as string);
        setOcrResult('');
      };
      reader.readAsDataURL(file);
    }
  };

  // Template matching and OCR
  const handleOcr = async () => {
    if (!image || !canvasRef.current) return;
    setLoading(true);
    setOcrResult('');
    setWarpedDataUrl(null);
    setCodeAreaDataUrl(null);
    setDebugOverlayUrl(null);
    setError(null);
    try {
      const cv = (window as any).cv;
      if (!cv || !cv.Mat) {
        setError('OpenCV.js is not loaded yet. Please try again in a moment.');
        setLoading(false);
        return;
      }
      // Load uploaded image and sign template as HTMLImageElement
      const [img, templateImg] = await Promise.all([
        loadImage(image),
        loadImage(signTemplate),
      ]);
      // Convert both to grayscale
      const src = cv.imread(img);
      const templ = cv.imread(templateImg);
      let graySrc = new cv.Mat();
      let grayTempl = new cv.Mat();
      cv.cvtColor(src, graySrc, cv.COLOR_RGBA2GRAY, 0);
      cv.cvtColor(templ, grayTempl, cv.COLOR_RGBA2GRAY, 0);
      // ORB feature detection
      let orb = new cv.ORB();
      let kp1 = new cv.KeyPointVector();
      let des1 = new cv.Mat();
      orb.detectAndCompute(grayTempl, new cv.Mat(), kp1, des1);
      let kp2 = new cv.KeyPointVector();
      let des2 = new cv.Mat();
      orb.detectAndCompute(graySrc, new cv.Mat(), kp2, des2);
      // Match features
      let bf = new cv.BFMatcher(cv.NORM_HAMMING, true);
      let matches = new cv.DMatchVector();
      bf.match(des1, des2, matches);
      // Filter good matches
      let goodMatches = [];
      for (let i = 0; i < matches.size(); i++) {
        goodMatches.push(matches.get(i));
      }
      goodMatches.sort((a, b) => a.distance - b.distance);
      goodMatches = goodMatches.slice(0, 20); // take top 20 matches
      if (goodMatches.length < 4) {
        setError('Not enough good matches found for homography.');
        src.delete(); templ.delete(); graySrc.delete(); grayTempl.delete();
        orb.delete(); kp1.delete(); kp2.delete(); des1.delete(); des2.delete(); bf.delete(); matches.delete();
        setLoading(false);
        return;
      }
      // Prepare points for homography
      let srcPoints = [];
      let dstPoints = [];
      for (let i = 0; i < goodMatches.length; i++) {
        srcPoints.push(kp1.get(goodMatches[i].queryIdx).pt);
        dstPoints.push(kp2.get(goodMatches[i].trainIdx).pt);
      }
      let srcMat = cv.matFromArray(srcPoints.length, 1, cv.CV_32FC2, ([] as number[]).concat(...srcPoints.map(pt => [pt.x, pt.y])));
      let dstMat = cv.matFromArray(dstPoints.length, 1, cv.CV_32FC2, ([] as number[]).concat(...dstPoints.map(pt => [pt.x, pt.y])));
      // Find homography
      let mask = new cv.Mat();
      let H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5, mask);
      if (H.empty()) {
        setError('Homography estimation failed.');
        src.delete(); templ.delete(); graySrc.delete(); grayTempl.delete();
        orb.delete(); kp1.delete(); kp2.delete(); des1.delete(); des2.delete(); bf.delete(); matches.delete();
        srcMat.delete(); dstMat.delete(); mask.delete(); H.delete();
        setLoading(false);
        return;
      }
      // Warp template corners to source image
      let templCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        grayTempl.cols, 0,
        grayTempl.cols, grayTempl.rows,
        0, grayTempl.rows
      ]);
      let warpedCorners = new cv.Mat();
      cv.perspectiveTransform(templCorners, warpedCorners, H);
      
      // Get bounding box of warped corners (the detected sign)
      let xCoords = [], yCoords = [];
      for (let i = 0; i < 4; i++) {
        xCoords.push(warpedCorners.data32F[i * 2]);
        yCoords.push(warpedCorners.data32F[i * 2 + 1]);
      }
      console.log('Template dimensions:', { cols: grayTempl.cols, rows: grayTempl.rows });
      console.log('Warped corner coordinates:', xCoords, yCoords);
      
      let minX = Math.max(0, Math.floor(Math.min(...xCoords)));
      let minY = Math.max(0, Math.floor(Math.min(...yCoords)));
      let maxX = Math.min(src.cols, Math.ceil(Math.max(...xCoords)));
      let maxY = Math.min(src.rows, Math.ceil(Math.max(...yCoords)));
      let width = maxX - minX;
      let height = maxY - minY;
      console.log('Detected sign bounding box:', { minX, minY, maxX, maxY, width, height });
      if (width <= 0 || height <= 0) {
        setError('Warped region is invalid.');
        src.delete(); templ.delete(); graySrc.delete(); grayTempl.delete();
        orb.delete(); kp1.delete(); kp2.delete(); des1.delete(); des2.delete(); bf.delete(); matches.delete();
        srcMat.delete(); dstMat.delete(); mask.delete(); H.delete(); templCorners.delete(); warpedCorners.delete();
        setLoading(false);
        return;
      }
      // Now, crop the code area as a fixed region relative to the sign's bounding box
      // Based on the sign structure, the white code area is at the bottom of the sign
      const codeArea = {
        x: 0.15, // 15% from left (narrower to focus on the white area)
        y: 0.75, // 75% from top (target the bottom white area)
        width: 0.7, // 70% width (narrower to focus on the white area)
        height: 0.2 // 20% height (taller to capture the full white area)
      };
      const codeX = minX + width * codeArea.x;
      const codeY = minY + height * codeArea.y;
      const codeW = width * codeArea.width;
      const codeH = height * codeArea.height;
      console.log('Crop calculations:', { codeArea, codeX, codeY, codeW, codeH });
      // Crop the code area from the original image
      const codeRect = new cv.Rect(Math.round(codeX), Math.round(codeY), Math.round(codeW), Math.round(codeH));
      console.log('Final crop rectangle:', { x: codeRect.x, y: codeRect.y, width: codeRect.width, height: codeRect.height });
      
      // Create debug overlay showing the detected sign and crop area
      const debugCanvas = document.createElement('canvas');
      debugCanvas.width = src.cols;
      debugCanvas.height = src.rows;
      const debugCtx = debugCanvas.getContext('2d')!;
      // Draw the original image
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = src.cols;
      tempCanvas.height = src.rows;
      cv.imshow(tempCanvas, src);
      debugCtx.drawImage(tempCanvas, 0, 0);
      // Draw detected sign bounding box (red)
      debugCtx.strokeStyle = 'red';
      debugCtx.lineWidth = 3;
      debugCtx.strokeRect(minX, minY, width, height);
      // Draw crop area (green)
      debugCtx.strokeStyle = 'green';
      debugCtx.lineWidth = 2;
      debugCtx.strokeRect(codeRect.x, codeRect.y, codeRect.width, codeRect.height);
      setDebugOverlayUrl(debugCanvas.toDataURL('image/png'));
      
      const codeMat = src.roi(codeRect);
      // Draw to canvas for OCR
      const canvas = canvasRef.current;
      canvas.width = codeMat.cols;
      canvas.height = codeMat.rows;
      cv.imshow(canvas, codeMat);
      setCodeAreaDataUrl(canvas.toDataURL('image/png'));
      // Clean up
      src.delete(); templ.delete(); graySrc.delete(); grayTempl.delete();
      orb.delete(); kp1.delete(); kp2.delete(); des1.delete(); des2.delete(); bf.delete(); matches.delete();
      srcMat.delete(); dstMat.delete(); mask.delete(); H.delete(); templCorners.delete(); warpedCorners.delete();
      // Run OCR on the code area
      const dataUrl = canvas.toDataURL('image/png');
      const { data: { text } } = await Tesseract.recognize(dataUrl, 'eng', {
        params: {
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',
        },
      } as any);
      setOcrResult(text.trim());
    } catch (err: any) {
      setError('Error during hybrid template matching or OCR: ' + (err?.message || err));
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Helper to load an image from a URL or data URL
  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new window.Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  return (
    <div style={{ maxWidth: 400, margin: '0 auto', padding: 16 }}>
      <h2>Summer Game Code OCR</h2>
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        onChange={handleFileChange}
        style={{ marginBottom: 16 }}
      />
      {image && (
        <div style={{ marginBottom: 16 }}>
          <img
            src={image}
            alt="Uploaded preview"
            style={{ width: '100%', border: '1px solid #ccc', marginBottom: 8 }}
          />
          <div style={{ fontSize: 12, color: '#555' }}>
            The code will be detected automatically using template matching.
          </div>
        </div>
      )}
      {graySrcUrl && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: '#555' }}>Grayscale uploaded image:</div>
          <img src={graySrcUrl} alt="Grayscale uploaded" style={{ width: '100%', border: '1px solid #aaa', marginTop: 4 }} />
        </div>
      )}
      {grayTemplUrl && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: '#555' }}>Grayscale template image:</div>
          <img src={grayTemplUrl} alt="Grayscale template" style={{ width: '100%', border: '1px solid #aaa', marginTop: 4 }} />
        </div>
      )}
      {error && (
        <div style={{ color: 'red', marginBottom: 16 }}>
          <strong>Error:</strong> {error}
      </div>
      )}
      <button onClick={handleOcr} disabled={!image || loading} style={{ marginBottom: 16 }}>
        {loading ? 'Reading...' : 'Read Code'}
        </button>
      <div style={{ marginBottom: 16 }}>
        <label htmlFor="ocr-result">Code:</label>
        <input
          id="ocr-result"
          type="text"
          value={ocrResult}
          readOnly
          style={{ width: '100%', fontSize: 20, textAlign: 'center', marginTop: 4 }}
        />
      </div>
      {codeAreaDataUrl && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#555' }}>Code area sent to OCR:</div>
          <img src={codeAreaDataUrl} alt="Code area for OCR" style={{ width: '100%', border: '1px solid #aaa', marginTop: 4 }} />
        </div>
      )}
      {debugOverlayUrl && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#555' }}>Debug Overlay:</div>
          <img src={debugOverlayUrl} alt="Debug Overlay" style={{ width: '100%', border: '1px solid #aaa', marginTop: 4 }} />
        </div>
      )}
      {/* Hidden canvas for cropping */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      {!opencvReady && (
        <div style={{ color: 'red', fontSize: 12 }}>
          OpenCV.js is loading... Please wait before using template matching.
        </div>
      )}
    </div>
  );
}

export default App;
