
import csv
from pathlib import Path

# Update this path if your file is stored elsewhere.
file_path = Path("data/skill_builder_data.csv")

if not file_path.exists():
    print("File not found:", file_path.resolve())
else:
    with file_path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.reader(file)

        columns = next(reader)
        print("\nCOLUMN NAMES:")
        for column in columns:
            print("-", column)

        print("\nFIRST 5 ROWS:")
        for i, row in enumerate(reader):
            print(dict(zip(columns, row)))
            if i == 4:
                break
