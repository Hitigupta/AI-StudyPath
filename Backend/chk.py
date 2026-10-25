
from database import get_connection
from weakness_detector import analyze_live_weaknesses


conn = get_connection()

try:
    rows = conn.execute(
        """
        SELECT student_id, topic, concept, is_correct
        FROM question_responses
        WHERE student_id = ?
        ORDER BY attempted_at, id
        """,
        (2,)
    ).fetchall()

    responses = [dict(row) for row in rows]

finally:
    conn.close()


results = analyze_live_weaknesses(responses)

for item in results:
    print(item)
