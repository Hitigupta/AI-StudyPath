import os
import json
import sqlite3
from functools import wraps
import math
from weakness_detector import analyze_live_weaknesses
from flask import render_template
from weakness_detector import (
    build_student_skill_profiles,
    generate_revision_recommendations
)

from dotenv import load_dotenv
from flask import Flask, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash

from database import get_connection, create_tables
from ai_service import generate_quiz
import pandas as pd
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROFILES_PATH = BASE_DIR / "data" / "student_skill_profiles.csv"

profiles = pd.read_csv(PROFILES_PATH)

print(f"Loaded {len(profiles)} student-skill profiles.")

# Load environment variables from Backend/.env
load_dotenv()

import os
from flask import Flask, render_template

app = Flask(
    __name__,
    template_folder="templates",
    static_folder=os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "Frontend")
    ),
    static_url_path="/static"
)

# A secret key is required to sign session cookies.
app.secret_key = os.getenv("FLASK_SECRET_KEY")

if not app.secret_key:
    raise RuntimeError(
        "FLASK_SECRET_KEY is missing. Add it to your Backend/.env file."
    )

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # Set True when deployed over HTTPS.
)

create_tables()


def login_required(route_function):
    @wraps(route_function)
    def wrapper(*args, **kwargs):
        if "student_id" not in session:
            return jsonify({"error": "Please log in first"}), 401

        return route_function(*args, **kwargs)

    return wrapper


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}

    username = data.get("username")
    email = data.get("email")
    password = data.get("password")

    if not all(isinstance(value, str) for value in
               (username, email, password)):
        return jsonify({
            "error": "Username, email and password are required"
        }), 400

    username = username.strip()
    email = email.strip().lower()

    if not username or not email:
        return jsonify({
            "error": "Username and email cannot be empty"
        }), 400

    if len(username) > 50 or len(email) > 254:
        return jsonify({"error": "Username or email is too long"}), 400

    if len(password) < 8:
        return jsonify({
            "error": "Password must contain at least 8 characters"
        }), 400

    password_hash = generate_password_hash(password)

    conn = get_connection()

    try:
        cursor = conn.execute(
            """
            INSERT INTO students (username, email, password_hash)
            VALUES (?, ?, ?)
            """,
            (username, email, password_hash)
        )

        conn.commit()
        student_id = cursor.lastrowid

    except sqlite3.IntegrityError:
        conn.rollback()
        return jsonify({
            "error": "Username or email is already registered"
        }), 409

    finally:
        conn.close()

    return jsonify({
        "message": "Registration successful",
        "student": {
            "id": student_id,
            "username": username,
            "email": email
        }
    }), 201



@app.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}

    identifier = data.get("username_or_email")
    password = data.get("password")

    if (
        not isinstance(identifier, str)
        or not identifier.strip()
        or not isinstance(password, str)
        or not password
    ):
        return jsonify({
            "error": "Username/email and password are required"
        }), 400

    identifier = identifier.strip()

    conn = get_connection()

    try:
        student = conn.execute(
            """
            SELECT id, username, email, password_hash
            FROM students
            WHERE username = ? OR email = ?
            """,
            (identifier, identifier.lower())
        ).fetchone()
    finally:
        conn.close()

    if (
        student is None
        or not check_password_hash(student["password_hash"], password)
    ):
        return jsonify({
            "error": "Invalid username/email or password"
        }), 401

    # Start a fresh session after successful authentication.
    session.clear()
    session["student_id"] = student["id"]

    return jsonify({
        "message": "Login successful",
        "student": {
            "id": student["id"],
            "username": student["username"],
            "email": student["email"]
        }
    }), 200



@app.route("/me", methods=["GET"])
@login_required
def get_current_student():
    conn = get_connection()

    try:
        student = conn.execute(
            """
            SELECT id, username, email, created_at
            FROM students
            WHERE id = ?
            """,
            (session["student_id"],)
        ).fetchone()
    finally:
        conn.close()

    if student is None:
        session.clear()
        return jsonify({"error": "Student account not found"}), 401

    return jsonify({"student": dict(student)}), 200


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"message": "Logged out successfully"}), 200


@app.route("/add_attempt", methods=["POST"])
@login_required
def add_attempt():
    data = request.get_json(silent=True) or {}

    topic = data.get("topic")
    total_questions = data.get("total_questions")
    correct_answers = data.get("correct_answers")
    time_taken = data.get("time_taken", 0)

    if not isinstance(topic, str) or not topic.strip():
        return jsonify({"error": "A topic is required"}), 400

    if (
        not isinstance(total_questions, int)
        or isinstance(total_questions, bool)
        or not isinstance(correct_answers, int)
        or isinstance(correct_answers, bool)
        or total_questions <= 0
        or correct_answers < 0
        or correct_answers > total_questions
    ):
        return jsonify({"error": "Invalid quiz data"}), 400

    if (
        isinstance(time_taken, bool)
        or not isinstance(time_taken, (int, float))
        or time_taken < 0
    ):
        return jsonify({"error": "Invalid time_taken value"}), 400

    conn = get_connection()

    try:
        conn.execute(
            """
            INSERT INTO quiz_attempts
                (student_id, topic, total_questions,
                 correct_answers, time_taken)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                session["student_id"],
                topic.strip(),
                total_questions,
                correct_answers,
                time_taken
            )
        )

        conn.commit()
    finally:
        conn.close()

    return jsonify({"message": "Quiz attempt saved successfully"}), 201



@app.route("/attempts", methods=["GET"])
@login_required
def get_attempts():
    conn = get_connection()

    try:
        attempts = conn.execute(
            """
            SELECT *
            FROM quiz_attempts
            WHERE student_id = ?
            ORDER BY id DESC
            """,
            (session["student_id"],)
        ).fetchall()
    finally:
        conn.close()

    return jsonify([dict(attempt) for attempt in attempts]), 200



@app.route("/stats", methods=["GET"])
@login_required
def get_stats():
    student_id = session["student_id"]
    conn = get_connection()

    try:
        # Overall student performance
        stats = conn.execute(
            """
            SELECT
                COUNT(*) AS total_attempts,
                COALESCE(SUM(total_questions), 0) AS total_questions,
                COALESCE(SUM(correct_answers), 0) AS correct_answers
            FROM quiz_attempts
            WHERE student_id = ?
            """,
            (student_id,)
        ).fetchone()

        # Performance for each concept
        concept_rows = conn.execute(
            """
            SELECT
                topic,
                concept,
                COUNT(*) AS questions_attempted,
                SUM(is_correct) AS correct_answers,
                ROUND(AVG(is_correct) * 100, 2) AS accuracy
            FROM question_responses
            WHERE student_id = ?
            GROUP BY topic, concept
            ORDER BY accuracy ASC, questions_attempted DESC
            """,
            (student_id,)
        ).fetchall()

        # Accuracy on the five most recent answers per concept
        recent_rows = conn.execute(
            """
            SELECT
                topic,
                concept,
                ROUND(AVG(is_correct) * 100, 2) AS recent_accuracy
            FROM (
                SELECT
                    topic,
                    concept,
                    is_correct,
                    ROW_NUMBER() OVER (
                        PARTITION BY topic, concept
                        ORDER BY attempted_at DESC, id DESC
                    ) AS row_num
                FROM question_responses
                WHERE student_id = ?
            )
            WHERE row_num <= 5
            GROUP BY topic, concept
            """,
            (student_id,)
        ).fetchall()

    finally:
        conn.close()

    total_questions = stats["total_questions"]
    correct_answers = stats["correct_answers"]

    accuracy = (
        round(correct_answers / total_questions * 100, 2)
        if total_questions > 0
        else 0
    )

    recent_accuracy_map = {
        (row["topic"], row["concept"]): row["recent_accuracy"]
        for row in recent_rows
    }

    concepts = []

    for row in concept_rows:
        attempted = row["questions_attempted"]

        concepts.append({
            "topic": row["topic"],
            "concept": row["concept"],
            "questions_attempted": attempted,
            "correct_answers": row["correct_answers"],
            "accuracy": row["accuracy"],
            "recent_accuracy": recent_accuracy_map.get(
                (row["topic"], row["concept"])
            ),
            "enough_data": attempted >= 5
        })

    return jsonify({
        "student_id": student_id,
        "total_attempts": stats["total_attempts"],
        "total_questions": total_questions,
        "correct_answers": correct_answers,
        "accuracy": accuracy,
        "concepts": concepts
    }), 200

@app.route("/recommend", methods=["GET"])
@login_required
def recommend_study():
    student_id = session["student_id"]
    conn = get_connection()

    try:
        attempts = conn.execute(
            """
            SELECT
                topic,
                total_questions,
                correct_answers,
                attempted_at
            FROM quiz_attempts
            WHERE student_id = ?
            ORDER BY id DESC
            """,
            (student_id,)
        ).fetchall()
    finally:
        conn.close()

    # No quiz history yet.
    if not attempts:
        return jsonify({
            "student_id": student_id,
            "recommendation": (
                "Take your first quiz to get personalized "
                "study recommendations."
            )
        }), 200

    # Group quiz attempts by topic.
    topic_data = {}

    for attempt in attempts:
        topic = attempt["topic"]

        if topic not in topic_data:
            topic_data[topic] = {
                "attempts": [],
                "total_questions": 0,
                "correct_answers": 0
            }

        topic_data[topic]["attempts"].append(attempt)
        topic_data[topic]["total_questions"] += (
            attempt["total_questions"]
        )
        topic_data[topic]["correct_answers"] += (
            attempt["correct_answers"]
        )

    topic_performance = []

    for topic, data in topic_data.items():
        total = data["total_questions"]
        correct = data["correct_answers"]

        accuracy = (
            correct / total * 100
            if total > 0 else 0
        )

        # Evaluate the three most recent attempts for this topic.
        recent_attempts = data["attempts"][:3]

        recent_total = sum(
            a["total_questions"] for a in recent_attempts
        )
        recent_correct = sum(
            a["correct_answers"] for a in recent_attempts
        )

        recent_accuracy = (
            recent_correct / recent_total * 100
            if recent_total > 0 else 0
        )

        # Positive trend means improvement.
        trend = round(recent_accuracy - accuracy, 2)

        # Higher scores indicate a greater need for revision.
        error_rate = 100 - accuracy
        decline = max(0, -trend)

        priority_score = round(
            0.7 * error_rate + 0.3 * decline,
            2
        )

        topic_performance.append({
            "topic": topic,
            "attempts": len(data["attempts"]),
            "total_questions": total,
            "correct_answers": correct,
            "accuracy": round(accuracy, 2),
            "recent_accuracy": round(recent_accuracy, 2),
            "trend": trend,
            "priority_score": priority_score,
            "needs_more_data": total < 10
        })

    # Highest priority score means revise this topic first.
    recommended = max(
        topic_performance,
        key=lambda item: item["priority_score"]
    )

    if recommended["needs_more_data"]:
        recommendation = (
            f"Start by revising {recommended['topic']}. "
            f"Your accuracy is {recommended['accuracy']}%, "
            "but there are fewer than 10 questions of evidence. "
            "Take more quizzes to assess your mastery reliably."
        )
    elif recommended["trend"] > 0:
        recommendation = (
            f"Continue practising {recommended['topic']}. "
            f"Your recent accuracy is "
            f"{recommended['recent_accuracy']}%, showing "
            f"improvement compared with your overall accuracy "
            f"of {recommended['accuracy']}%."
        )
    elif recommended["trend"] < 0:
        recommendation = (
            f"Prioritize revision of {recommended['topic']}. "
            f"Your recent accuracy is "
            f"{recommended['recent_accuracy']}%, below your "
            f"overall accuracy of {recommended['accuracy']}%."
        )
    else:
        recommendation = (
            f"Focus on {recommended['topic']}. "
            f"Your overall accuracy is {recommended['accuracy']}%. "
            "Practise more questions to strengthen this topic."
        )

    return jsonify({
        "student_id": student_id,
        "topic_performance": topic_performance,
        "recommended_topic": recommended["topic"],
        "recommended_accuracy": recommended["accuracy"],
        "priority_score": recommended["priority_score"],
        "recommendation": recommendation
    }), 200


@app.route("/generate_quiz", methods=["POST"])
def generate_quiz_route():
    if "student_id" not in session:
        return jsonify({"error": "Please log in first"}), 401

    data = request.get_json(silent=True) or {}

    topic = data.get("topic")
    difficulty = data.get("difficulty", "medium")
    num_questions = data.get("num_questions", 5)

    if not isinstance(topic, str) or not topic.strip():
        return jsonify({"error": "Topic is required"}), 400

    if difficulty not in ["easy", "medium", "hard"]:
        return jsonify({"error": "Invalid difficulty"}), 400

    if (
        not isinstance(num_questions, int)
        or isinstance(num_questions, bool)
        or not 1 <= num_questions <= 10
    ):
        return jsonify({
            "error": "Number of questions must be between 1 and 10"
        }), 400

    try:
        result = generate_quiz(
            topic=topic.strip(),
            difficulty=difficulty,
            num_questions=num_questions
        )

        questions = json.loads(result)

        if (
            not isinstance(questions, list)
            or len(questions) != num_questions
        ):
            return jsonify({
                "error": "AI returned an invalid number of questions"
            }), 502

        for question in questions:
            if (
                not isinstance(question, dict)
                or not isinstance(question.get("question"), str)
                or not isinstance(question.get("concept"), str)
                or not question["concept"].strip()
                or not isinstance(question.get("options"), list)
                or len(question["options"]) != 4
                or not all(
                    isinstance(option, str)
                    for option in question["options"]
                )
                or len(set(question["options"])) != 4
                or not isinstance(question.get("answer"), str)
                or question["answer"] not in question["options"]
                or not isinstance(question.get("explanation"), str)
            ):
                return jsonify({
                    "error": "AI returned an invalid question format"
                }), 502

        conn = get_connection()

        cursor = conn.execute(
            """
            INSERT INTO generated_quizzes
                (student_id, topic, difficulty, questions_json, submitted)
            VALUES (?, ?, ?, ?, 0)
            """,
            (
                session["student_id"],
                topic.strip(),
                difficulty,
                json.dumps(questions),
            )
        )

        quiz_id = cursor.lastrowid
        conn.commit()
        conn.close()

        public_questions = [
            {
                "question": question["question"],
                "options": question["options"],
                "concept": question["concept"]
            }
            for question in questions
        ]

        return jsonify({
            "message": "Quiz generated successfully",
            "quiz_id": quiz_id,
            "topic": topic.strip(),
            "difficulty": difficulty,
            "questions": public_questions
        }), 201

    except json.JSONDecodeError:
        return jsonify({
            "error": "AI returned invalid JSON"
        }), 502

    except Exception as e:
        print("Quiz generation error:", str(e), flush=True)
        return jsonify({
            "error": "Failed to generate quiz"
        }), 500



@app.route("/submit_quiz", methods=["POST"])
@login_required
def submit_quiz():
    data = request.get_json(silent=True) or {}

    quiz_id = data.get("quiz_id")
    answers = data.get("answers")
    time_taken = data.get("time_taken", 0)

    if (
        not isinstance(quiz_id, int)
        or isinstance(quiz_id, bool)
        or quiz_id <= 0
    ):
        return jsonify({"error": "Invalid quiz_id"}), 400

    if not isinstance(answers, dict):
        return jsonify({"error": "Answers must be a JSON object"}), 400

    if (
        isinstance(time_taken, bool)
        or not isinstance(time_taken, (int, float))
        or not math.isfinite(time_taken)
        or time_taken < 0
    ):
        return jsonify({"error": "Invalid time_taken"}), 400

    conn = get_connection()

    try:
        quiz = conn.execute(
            """
            SELECT id, student_id, topic, difficulty,
                   questions_json, submitted
            FROM generated_quizzes
            WHERE id = ? AND student_id = ?
            """,
            (quiz_id, session["student_id"])
        ).fetchone()

        if quiz is None:
            return jsonify({"error": "Quiz not found"}), 404

        if quiz["submitted"]:
            return jsonify({
                "error": "This quiz has already been submitted"
            }), 409

        questions = json.loads(quiz["questions_json"])

        expected_keys = {str(i) for i in range(len(questions))}

        if set(answers.keys()) != expected_keys:
            return jsonify({
                "error": "Submit exactly one answer for every question"
            }), 400

        correct_count = 0
        reviewed_questions = []
        normalized_answers = {}
        question_records = []

        for i, question in enumerate(questions):
            selected = answers[str(i)]
            options = question["options"]
            correct_answer = question["answer"]
            concept = question.get("concept", "Unknown")

            if not isinstance(selected, str) or selected not in options:
                return jsonify({
                    "error": f"Invalid option for question {i}"
                }), 400

            is_correct = selected == correct_answer

            if is_correct:
                correct_count += 1

            normalized_answers[str(i)] = selected

            reviewed_questions.append({
                "question": question["question"],
                "concept": concept,
                "selected_answer": selected,
                "correct_answer": correct_answer,
                "is_correct": is_correct,
                "explanation": question["explanation"]
            })

            question_records.append((
                session["student_id"],
                quiz_id,
                i,
                quiz["topic"],
                concept,
                quiz["difficulty"],
                selected,
                correct_answer,
                int(is_correct)
            ))

        total_questions = len(questions)

        score_percent = round(
            correct_count / total_questions * 100, 2
        )

        # Start one transaction for all database changes.
        conn.execute("BEGIN")

        # Prevent duplicate submissions.
        cursor = conn.execute(
            """
            UPDATE generated_quizzes
            SET submitted = 1
            WHERE id = ?
              AND student_id = ?
              AND submitted = 0
            """,
            (quiz_id, session["student_id"])
        )

        if cursor.rowcount != 1:
            conn.rollback()
            return jsonify({
                "error": "This quiz has already been submitted"
            }), 409

        # Preserve the existing aggregate attempt record.
        conn.execute(
            """
            INSERT INTO quiz_attempts (
                student_id,
                topic,
                total_questions,
                correct_answers,
                time_taken,
                quiz_id,
                answers_json,
                score_percent
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session["student_id"],
                quiz["topic"],
                total_questions,
                correct_count,
                time_taken,
                quiz_id,
                json.dumps(normalized_answers),
                score_percent
            )
        )

        # Save one record per question and concept.
        conn.executemany(
            """
            INSERT INTO question_responses (
                student_id,
                quiz_id,
                question_index,
                topic,
                concept,
                difficulty,
                selected_answer,
                correct_answer,
                is_correct
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            question_records
        )

        conn.commit()

        return jsonify({
            "message": "Quiz submitted and graded successfully",
            "quiz_id": quiz_id,
            "topic": quiz["topic"],
            "total_questions": total_questions,
            "correct_answers": correct_count,
            "incorrect_answers": total_questions - correct_count,
            "score_percent": score_percent,
            "time_taken": time_taken,
            "review": reviewed_questions
        }), 200

    except Exception:
        conn.rollback()
        app.logger.exception("Quiz submission failed")
        return jsonify({
            "error": "Quiz submission failed"
        }), 500

    finally:
        conn.close()



@app.route("/mistakes", methods=["GET"])
@login_required
def get_mistakes():
    student_id = session["student_id"]
    conn = get_connection()

    try:
        rows = conn.execute(
            """
            SELECT
                qa.topic,
                qa.answers_json,
                gq.questions_json
            FROM quiz_attempts AS qa
            JOIN generated_quizzes AS gq
                ON qa.quiz_id = gq.id
            WHERE qa.student_id = ?
            ORDER BY qa.id DESC
            """,
            (student_id,)
        ).fetchall()

        mistake_counts = {}

        for row in rows:
            if not row["answers_json"] or not row["questions_json"]:
                continue

            answers = json.loads(row["answers_json"])
            questions = json.loads(row["questions_json"])

            for index, question in enumerate(questions):
                selected = answers.get(str(index))

                if selected is None:
                    continue

                correct = question["answer"]

                if selected == correct:
                    continue

                topic = row["topic"]
                question_text = question["question"]

                key = (topic, question_text)

                if key not in mistake_counts:
                    mistake_counts[key] = {
                        "topic": topic,
                        "question": question_text,
                        "wrong_attempts": 0,
                        "correct_answer": correct,
                        "explanation": question.get(
                            "explanation", ""
                        )
                    }

                mistake_counts[key]["wrong_attempts"] += 1

        mistakes = sorted(
            mistake_counts.values(),
            key=lambda item: item["wrong_attempts"],
            reverse=True
        )

        return jsonify({
            "student_id": student_id,
            "recurring_mistakes": mistakes
        }), 200

    except (json.JSONDecodeError, TypeError):
        app.logger.exception("Could not analyze quiz mistakes")
        return jsonify({
            "error": "Could not analyze stored quiz data"
        }), 500

    finally:
        conn.close()


@app.route("/weaknesses", methods=["GET"])
@login_required
def get_weaknesses():
    student_id = session["student_id"]
    conn = get_connection()

    try:
        rows = conn.execute(
            """
            SELECT student_id, topic, concept, is_correct
            FROM question_responses
            WHERE student_id = ?
            ORDER BY attempted_at, id
            """,
            (student_id,)
        ).fetchall()

        responses = [dict(row) for row in rows]

    finally:
        conn.close()

    results = analyze_live_weaknesses(responses)

    return jsonify({
        "student_id": student_id,
        "concepts_analyzed": len(results),
        "weak_concepts": sum(
            item["status"] == "Weak" for item in results
        ),
        "results": results
    }), 200


if __name__ == "__main__":
    app.run(debug=True)
