import sys
import subprocess

def install(package):
    subprocess.check_call([sys.executable, "-m", "pip", "install", package, "--quiet"])

try:
    import PyPDF2
except ImportError:
    install('PyPDF2')
    import PyPDF2

pdf_path = sys.argv[1]
txt_path = sys.argv[2]

try:
    with open(pdf_path, 'rb') as f:
        reader = PyPDF2.PdfReader(f)
        text = ''
        for i, page in enumerate(reader.pages):
            text += f"\n--- Page {i+1} ---\n"
            text += page.extract_text() + '\n'

    with open(txt_path, 'w', encoding='utf-8') as out:
        out.write(text)
    print("Extraction complete.")
except Exception as e:
    print(f"Error extracting PDF: {e}")
