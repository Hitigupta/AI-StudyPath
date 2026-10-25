import sqlite3
from weakness_detector import (
    build_student_skill_profiles,
    generate_revision_recommendations
)

def get_connection():
    conn = sqlite3.connect("studypath.db")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def create_tables():
    conn = get_connection()

    # Store registered students
    conn.execute("""
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Link generated quizzes to their owners.
    # Existing quizzes remain available with student_id = NULL.
    quiz_columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(generated_quizzes)"
        ).fetchall()
    }

    if "student_id" not in quiz_columns:
        conn.execute("""
            ALTER TABLE generated_quizzes
            ADD COLUMN student_id INTEGER
            REFERENCES students(id)
        """)

    # Link attempts to quizzes and retain submitted answers.
    attempt_columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(quiz_attempts)"
        ).fetchall()
    }

    if "quiz_id" not in attempt_columns:
        conn.execute("""
            ALTER TABLE quiz_attempts
            ADD COLUMN quiz_id INTEGER
            REFERENCES generated_quizzes(id)
        """)

    if "answers_json" not in attempt_columns:
        conn.execute("""
            ALTER TABLE quiz_attempts
            ADD COLUMN answers_json TEXT
        """)

    if "score_percent" not in attempt_columns:
        conn.execute("""
            ALTER TABLE quiz_attempts
            ADD COLUMN score_percent REAL
        """)

    
    # Add submission tracking to existing databases.
    quiz_columns = {
        row["name"]
        for row in conn.execute(
            "PRAGMA table_info(generated_quizzes)"
        ).fetchall()
    }

    if "submitted" not in quiz_columns:
        conn.execute("""
            ALTER TABLE generated_quizzes
            ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0
        """)
    
    conn.execute("""
        CREATE TABLE IF NOT EXISTS question_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            quiz_id INTEGER NOT NULL,
            question_index INTEGER NOT NULL,
            topic TEXT NOT NULL,
            concept TEXT NOT NULL,
            difficulty TEXT NOT NULL,
            selected_answer TEXT,
            correct_answer TEXT NOT NULL,
            is_correct INTEGER NOT NULL,
            attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (quiz_id, question_index)
        )
    """)

    conn.commit()
    conn.close()


if __name__ == "__main__":
    create_tables()
    print("Database and tables created successfully!")
