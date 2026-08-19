from flask import Flask
from flask_cors import CORS
from dotenv import load_dotenv
import os
from app.api.routes import bp as api_bp

base_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(base_dir, '.env')
load_dotenv(env_path)

app = Flask(__name__)
CORS(app, origins="*", allow_headers=["*"], methods=["*"])

print(os.getenv("BACKBOARD_API_KEY"))
app.register_blueprint(api_bp, url_prefix="/api")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)