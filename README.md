# AI StudyPath — Smart Student Weakness Detector

AI StudyPath is a personalized learning platform designed to help students identify knowledge gaps, track quiz performance, and make more informed revision decisions.

The project combines a Flask backend, a web-based interface, a database for learning records, and Gemini-powered quiz generation. The goal is to build an adaptive learning workflow that uses a student's performance across concepts to guide subsequent practice.

## Key Features

- **AI-Generated Quizzes:** Generate topic-based questions using the Gemini API.
- **Performance Tracking:** Record quiz attempts and individual question outcomes.
- **Weakness Detection:** Analyze student performance to identify concepts that may need additional practice.
- **Revision Recommendations:** Prioritize topics for revision based on available performance data.
- **Learning Analytics:** Track quiz history and performance through the application interface.
- **Adaptive Learning — In Progress:** Develop a feedback loop that selects subsequent topics and difficulty levels based on demonstrated mastery.

## Technology Stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Python, Flask
- **Database:** SQLite
- **AI Integration:** Google Gemini API
- **Data Analysis / ML:** Python, pandas, scikit-learn *(where used in the current implementation)*

## Project Structure

```text
AI-StudyPath/
├── Backend/
│   ├── ML/
│   ├── data/
│   ├── templates/
│   ├── ai_service.py
│   ├── app.py
│   ├── database.py
│   ├── weakness_detector.py
│   └── ...
├── Frontend/
│   ├── script.js
│   └── style.css
├── .gitignore
└── requirements.txt
```

## Getting Started

### Prerequisites

- Python installed
- Git
- A Google Gemini API key

### 1. Clone the repository

```bash
git clone <https://github.com/Hitigupta/AI-StudyPath>
cd AI-StudyPath
```

### 2. Create a virtual environment

```bash
python -m venv .venv
```

Activate it on Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure environment variables

Create a `.env` file inside the `Backend` directory and add your Gemini API key using the variable name expected by `Backend/ai_service.py`.

**Never commit your API key to GitHub.**

### 5. Run the application

```bash
cd Backend
python app.py
```

Open the local URL printed by Flask in your browser.

## Current Development Focus

The current development focus is to strengthen the adaptive learning pipeline by connecting concept-level performance analysis, weakness detection, revision prioritization, and subsequent quiz generation.

The objective is to make the learning path responsive to actual student performance rather than relying solely on static recommendations.

## Future Improvements

- More robust topic-level mastery estimation
- Adaptive question difficulty and topic selection
- Evaluation of ML-based weakness detection against baseline approaches
- Progress visualizations and learning improvement analysis
- Deployment for wider access

## Security

- Store API keys in environment variables.
- Do not commit `.env` files or private student data.
- Review dataset licenses and usage restrictions before redistributing datasets.

## License

A license has not yet been selected. Until one is added, reuse and redistribution are subject to the applicable rights and permissions.
