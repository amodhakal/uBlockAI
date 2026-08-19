# uBlockAI

An AI-powered Chrome extension that detects and blocks misinformation in social media feeds, specifically designed to protect senior citizens from AI-generated fake news.

## Overview

uBlockAI acts as an ad-blocker analog for AI misinformation. It analyzes Instagram posts using OCR (Optical Character Recognition) and AI agents to verify claims against reliable news sources, flagging potentially false information before users engage with it.

## Features

- **Real-time Analysis**: Automatically scans Instagram posts as users scroll through their feed
- **OCR Integration**: Extracts text from images using Tesseract OCR
- **AI-Powered Verification**: Multi-agent AI system that verifies claims using web search and credibility scoring
- **Misinformation Detection**: Generates AI scores, misinformation scores, and detailed reasoning with supporting evidence
- **User Control**: Allows users to set custom sensitivity parameters for content filtering
- **Visual Flagging**: Blurs or removes posts flagged as potential misinformation

## Architecture

### Frontend (Chrome Extension)
- **Location**: `/frontend/extension/`
- **Manifest**: Manifest v3 Chrome extension
- **Content Scripts**: Injected into Instagram pages to capture posts
- **Background Service Worker**: Handles communication with backend API
- **Popup Interface**: User settings and control panel

### Backend (Flask + AI Agents)
- **Location**: `/backend/`
- **Framework**: Flask with CORS support
- **AI Agents**: LangGraph-based multi-agent system
- **Tools**:
  - Web Search Tool: Searches alternative news sources
  - Credibility Tool: Assesses source reliability
  - Numeric Verification: Validates numerical claims
  - OCR Processing: Extracts text from images

## Tech Stack

### Frontend
- JavaScript (ES6+ modules)
- Chrome Extension Manifest v3
- HTML/CSS for popup interface

### Backend
- **Python 3.10+**
- **Flask**: Web framework
- **LangChain/LangGraph**: AI agent orchestration
- **Tesseract OCR**: Text extraction from images
- **BeautifulSoup**: Web scraping
- **OpenAI GPT-5**: LLM models

## Installation

### Prerequisites
- Python 3.10 or higher
- Tesseract OCR installed on your system
- Chrome browser

### Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Create a virtual environment (recommended):
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Install Tesseract OCR:
   - **macOS**: `brew install tesseract`
   - **Windows**: Download from [UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki) or official installer
   - **Linux**: `sudo apt-get install tesseract-ocr`

5. Create a `.env` file in `/backend/app/` with your API keys:
```
OPENAI_API_KEY=your_openai_api_key
```

6. Start the server:
```bash
flask --app app.main run --host 0.0.0.0 --port 8000 --debug
```
Or for production:
```bash
gunicorn --bind 0.0.0.0:8000 app.main:app
```

### Chrome Extension Setup

1. Open Chrome and navigate to `chrome://extensions/`

2. Enable "Developer mode" in the top right corner

3. Click "Load unpacked" and select the `/frontend/extension` folder

4. The extension icon should appear in your Chrome toolbar

5. Navigate to Instagram and the extension will automatically begin analyzing posts

## Usage

### Testing the Backend

You can test the OCR functionality directly:

```bash
python app/post_classifier.py --url "https://instagram.com/p/EXAMPLE" --caption "Example caption" --include-caption
```

### Using the Extension

1. **Install** the extension following the steps above
2. **Navigate** to Instagram
3. **Scroll** through your feed - posts will be automatically analyzed
4. **View flagged content**: Suspicious posts will be blurred or removed based on your settings
5. **Adjust settings**: Click the extension icon to modify sensitivity thresholds

### API Endpoints

- `POST /api/analyze_claims`: Analyzes a social media post for misinformation
  - Request body: `{ "url": "post_url", "caption": "caption_text", "ocr_text": "extracted_text" }`
  - Response: `{ "ai_score": float, "misinformation_score": float, "reasoning": string, "evidence": array }`

## Project Structure

```
uBlockAI/
├── backend/
│   ├── app/
│   │   ├── agents/
│   │   │   ├── langchain_agent.py   # Main AI agent orchestration
│   │   │   └── prompts.py            # LLM prompts
│   │   ├── api/
│   │   │   └── routes.py             # Flask routes (Blueprint)
│   │   ├── tools/
│   │   │   ├── web_search_tool.py    # Web search functionality
│   │   │   ├── credibility_tool.py   # Source credibility assessment
│   │   │   ├── numeric_verify.py     # Numerical claim verification
│   │   │   └── registry.py           # Tool registry
│   │   ├── schemas/
│   │   │   ├── agent_io.py           # Agent input/output schemas
│   │   │   └── tool_io.py            # Tool input/output schemas
│   │   ├── post_classifier.py        # OCR-based post classifier
│   │   ├── main.py                   # Flask entry point
│   │   └── TestScript.ipynb          # Testing notebook
│   └── requirements.txt
├── frontend/
│   └── extension/
│       ├── manifest.json             # Chrome extension manifest
│       ├── background.js             # Service worker
│       ├── script.js                 # Content script for Instagram
│       ├── popup.html                # Extension popup UI
│       ├── popup.js                  # Popup logic
│       ├── crime-scene.png           # Warning overlay image
│       └── background.png            # Extension background
└── README.md
```

## How It Works

1. **Content Capture**: The Chrome extension content script monitors Instagram posts
2. **Image Processing**: Post images are captured and sent to the backend
3. **OCR Extraction**: Tesseract OCR extracts text from images
4. **Claim Analysis**: The LangGraph AI agent analyzes the caption + OCR text
5. **Verification**: The agent uses web search tools to verify claims against reliable sources
6. **Scoring**: An AI score and misinformation score are calculated
7. **Response**: Results are returned to the frontend
8. **Flagging**: Posts exceeding misinformation thresholds are visually flagged or removed

## Challenges & Solutions

### Latency Optimization
The main challenge was reducing AI agent response time. We addressed this through:
- Prompt engineering to streamline agent reasoning
- Model selection optimization (balancing accuracy vs. speed)
- Potential for caching common claim patterns

### DOM Manipulation
Working with Instagram's dynamic DOM required careful handling of:
- Infinite scroll detection
- Post element identification
- Mutation observers for real-time updates

## Future Roadmap

- [ ] **Video/Reel Support**: Integrate TwelveLabs for video content analysis
- [ ] **Multi-Platform**: Extend support to Facebook, Twitter/X, TikTok
- [ ] **User Feedback Loop**: Allow users to report false positives/negatives
- [ ] **Offline Mode**: Basic fact-checking without API calls
- [ ] **Senior-Friendly UI**: Larger fonts, simplified controls, voice assistance

## Acknowledgments

Built during a hackathon with the goal of protecting vulnerable populations from AI-generated misinformation. The project demonstrates the power of multi-agent AI systems for content verification.

## License

MIT License - Feel free to use and modify for educational and non-commercial purposes.

## Contact

For questions or contributions, please open an issue in the repository.
