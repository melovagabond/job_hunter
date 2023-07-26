# This is just an example file not final

# Use an official Node.js runtime as the base image
FROM node:14

# Set the working directory inside the container
WORKDIR /app

# Copy the package.json and package-lock.json (if using npm) to leverage Docker cache
COPY ./api/package*.json ./api/
COPY ./client/package*.json ./client/
COPY ./worker/package*.json ./worker/

# Install the dependencies for each part of the application
RUN cd ./api && npm install
RUN cd ./client && npm install
RUN cd ./worker && npm install

# Copy the application files into the container
COPY ./api /app/api
COPY ./client /app/client
COPY ./worker /app/worker

# Expose any necessary ports (if your application uses specific ports)
# EXPOSE 3000

# Define the startup command for your application
# For example, to start the API and client development server concurrently, you can use the following command:
CMD ["npm", "run", "dev"]

# Alternatively, if you want to start the API, client, and worker separately, you can use multiple CMD statements, like this:
# CMD ["npm", "run", "start:api"]
# CMD ["npm", "run", "start:client"]
# CMD ["npm", "run", "start:worker"]
