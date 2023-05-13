const config = require('config');
const axios = require('axios');
const fs = require('fs')
const auth = config.get('auth');

function embedding(text, auth) {
    let data = JSON.stringify({
        "model": "text-embedding-ada-002",
        "input": text,
        "user": "naor-test-0"
    });

    let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'https://api.openai.com/v1/embeddings',
        headers: {
            'Authorization': `Bearer ${auth}`,
            'Content-Type': 'application/json'
        },
        data: data
    };

    return axios.request(config)
        .then((response) => {

            fs.writeFile('embedding.json', JSON.stringify(response.data), 'utf8', () => {
                console.log("Done")
            })
        }
        )
        .catch((error) => {
            console.log(error);
        });

}


const readFile = (path) => {
    const content = fs.readFileSync(path, 'utf-8');
    return content

}

const content = readFile("./source/all_code.js")
const embeddingJson = embedding(content, auth)
