
import express from 'express';

const app = express();
const port = 3500;

app.get('/', (req, res) => {
	const status = 200;
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth() + 1;
	const date = now.getDate();
	console.log(`${year}.${month}.${date}[${req.method}]::${req.originalUrl}`);
	res.status(status).json({message: status});
});

app.listen(port, () => {
	console.log(`Listening on port ${port}...`);
});
