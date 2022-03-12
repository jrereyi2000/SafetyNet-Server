import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import { ObjectID } from "bson";
import haversine from 'haversine-distance';
import axios from 'axios';

const api = express.Router();
let conn = null;
let db = null;
let Users = null;
let Groups = null;
let CommunityGroups = null;
let Requests = null;

api.use(bodyParser.json());
api.use(cors());

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.DB_NAME;
console.log(MONGODB_DB)

// check the MongoDB URI
if (!MONGODB_URI) {
    throw new Error('Define the MONGODB_URI environmental variable');
}

// check the MongoDB DB
if (!MONGODB_DB) {
    throw new Error('Define the MONGODB_DB environmental variable');
}

const initApi = async app => {
    app.set("json spaces", 2);
    app.use("/api", api);
    
    conn = await MongoClient.connect(MONGODB_URI);
    db = conn.db(MONGODB_DB);
    Users = db.collection('users');
    Groups = db.collection('groups');
    CommunityGroups = db.collection('community_groups');
    Requests = db.collection('requests');
};

const formatRequests = async (requests) => {
    for (const request of requests) {
        let formattedNetwork = [];
        const network = request.network
        formattedNetwork = formattedNetwork.concat(await Promise.all(network.connections.map(async (_id) => ({
            header: 'Connections', 
            data: (await Users.find({ _id: new ObjectId(_id) }).toArray())[0] 
        }) )))
        formattedNetwork = formattedNetwork.concat(await Promise.all(network.groups.map(async (_id) => ({
            header: 'My Groups', 
            data: (await Groups.find({ _id: new ObjectId(_id) }).toArray())[0] 
        }) )))
        request.network = formattedNetwork
    }
    return requests;
}

const formatUser = async (user) => {
    if (user.connections) {
        user.connections = await Promise.all(user.connections.map(async (_id) => (await Users.find({ _id: new ObjectId(_id) }).toArray())[0] ));
    }
    const groups = await Groups.find({ user_id: new ObjectId(user._id) }).toArray();
    for (const group of groups) {
        group.members = await Promise.all(group.members.map(async (_id) => (await Users.find({ _id: new ObjectId(_id) }).toArray())[0] ));
    }
    user.groups = groups

    if (user.communityGroups) {
        user.communityGroups = await Promise.all(user.communityGroups.map(async (_id) => (await CommunityGroups.find({ _id: new ObjectId(_id) }).toArray())[0] ));
    }

    const requests = await Requests.find({ user_id: new ObjectId(user._id) }).toArray();
    user.requests = await formatRequests(requests)
    user.requests.reverse()

    return user;
}

const getAddress = async (longitude, latitude) => {
    const res = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${process.env.GOOGLE_API_KEY}`);
    const results = res.data.results;
    // console.log(results[0].formatted_address);
    return results[0].formatted_address;
  };

api.get('/communityGroups/:lat/:lng', async (req, res) => {
    const { lat, lng } = req.params;

    const communityGroups = await CommunityGroups.find().toArray();

    for (const group of communityGroups) {
        const distance = haversine({lat, lng}, { lat: group.location.lat, lng: group.location.lng }) / 1609
        const address = await getAddress(group.location.lng, group.location.lat)
        group.distance = distance?.toFixed(1);
        group.address = address;
    }

    res.json({groups: communityGroups});
});

api.post('/addCommunityGroup', async (req, res) => {
    const { userId, groupId} = req.body
    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!groupId) return res.status(400).json({error: 'Invalid request. groupId is a required property'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});
    const groups = await CommunityGroups.find({_id: new ObjectId(groupId)}).toArray();
    if (!groups.length) return res.status(404).json({error: `No group with _id: ${groupId} found.`});

    let user = users[0];
    const communityGroup = groups[0];
    const existingCommGroups = user.communityGroups?.filter(group => group.equals(communityGroup._id));
    if (existingCommGroups?.length) return res.status(400).json({error: `Community Group has already been added.`});
    
    const newCommGroups = user.communityGroups?.concat([communityGroup._id]) ?? [communityGroup._id];

    await Users.updateOne({_id: new ObjectId(userId)}, { $set: { communityGroups: newCommGroups } });
    user.communityGroups = newCommGroups
    user = await formatUser(user);
    res.json({user});
});

api.post("/removeCommunityGroup", async (req, res) => {
    const { userId, groupId} = req.body
    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!groupId) return res.status(400).json({error: 'Invalid request. groupId is a required property'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});
    const groups = await CommunityGroups.find({_id: new ObjectId(groupId)}).toArray();
    if (!groups.length) return res.status(404).json({error: `No group with _id: ${groupId} found.`});

    let user = users[0];
    const communityGroup = groups[0];
    const existingCommGroups = user.communityGroups?.filter(group => group.equals(communityGroup._id));
    if (!existingCommGroups.length) return res.status(400).json({error: `Community Group has already been added.`});

    const newGroups = user.communityGroups?.filter(group => !group.equals(communityGroup._id));
    await Users.updateOne({_id: new ObjectId(userId)}, { $set: { communityGroups: newGroups } });
    user.communityGroups = newGroups
    user = await formatUser(user)
    res.json({user});
});

api.post('/groups', async (req, res) => {
    const { userId, memberIds, name, groupId} = req.body
  // console.log(userId)
  // console.log(memberIds)
  // console.log(name)
    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!memberIds || !Array.isArray(memberIds)) return res.status(400).json({error: 'Invalid request. memberIds is a required property, it must be an array'});
    if (!name) return res.status(400).json({error: 'Invalid request. name is a required property.'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});

    const dbIds = []
    for (const memberId of memberIds) {
        const members = await Users.find({_id: new ObjectId(memberId)}).toArray();
        if (!members.length) return res.status(404).json({error: `No user with _id: ${memberId} found.`});
        dbIds.push(members[0]._id);
    }

    let user = users[0]
   
    if (groupId) {
        const groups = await Groups.find({_id: new ObjectId(groupId)}).toArray();
        if (!groups.length) return res.status(404).json({error: `No group with _id: ${groupId} found.`});

        await Groups.updateOne({_id: new ObjectId(groupId)}, { $set: { name, members: dbIds } })
    } else {
        const newGroup = { user_id: user._id, name, members: dbIds}
        await Groups.insertOne(newGroup);
    }

    user = await formatUser(user);
    res.json({user})
});

api.get('/users/:id', async (req, res) => {
    const id = req.params.id
    console.log(id)
    if (!id) return res.status(400).json({error: 'Invalid request. id must be sent in the request params'});

    const users = await Users.find({_id: new ObjectId(id)}).toArray();
    console.log(users);
    if (!users.length) return res.status(404).json({error: `No user with _id: ${id} found.`});

    const user = await formatUser(users[0]);
    res.json({user})
});

api.post('/checkRequest', async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({error: 'Invalid request. requestId is a required property'});

    const requests = await Requests.find({_id: new ObjectId(requestId)}).toArray();
    if (!requests.length) return res.status(404).json({error: `No request with _id: ${requestId} found.`});

    res.json({accepted: requests[0].accepted_id })
});

api.post('/acceptRequest', async (req, res) => {
    const { acceptId, requestId } = req.body;
    if (!acceptId) return res.status(400).json({error: 'Invalid request. acceptId is a required property'});
    if (!requestId) return res.status(400).json({error: 'Invalid request. requestId is a required property'});

    let accepters = await Users.find({_id: new ObjectId(acceptId)}).toArray();
    if (!accepters.length) return res.status(404).json({error: `No user with _id: ${acceptId} found.`});

    const requests = await Requests.find({_id: new ObjectId(requestId)}).toArray();
    if (!requests.length) return res.status(404).json({error: `No request with _id: ${requestId} found.`});    

    const accepter = accepters[0];
    const request = requests[0];

    const idMatches = request.network.connections.filter(_id => _id.equals(accepter._id));

    let foundMatch = false;
    if (!idMatches.length) {
        for (const group_id of request.network.groups) {
            const group = (await Groups.find({_id: new ObjectID(group_id)}).toArray())[0]
            const groupIdMatches = group.members.filter(_id => _id.equals(accepter._id))
            if (groupIdMatches) foundMatch = true
        }
        if (!foundMatch) return res.status(404).json({error: `Accepter id: ${accepter._id} invalid. Accepter is not in request's network`}); 
    }

    if (request.accepted_id) return res.status(400).json({error: 'Request has already been accepted'});


    await Requests.updateOne({_id: new ObjectId(request._id)}, { $set: { accepted_id: accepter._id } })

    res.json({success: true})
});

api.get('/checkInbox/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({error: 'Invalid request. requestId is a required property'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});
    const user = users[0];

    const userGroups = await Groups.find({members: new ObjectID(users[0]._id)}).toArray();
    const userGroupIds = userGroups.map(g => g._id);

    let requests = await Requests.find({'network.connections': user._id}).toArray();
    for (const groupId of userGroupIds) {
        const groupRequests = await Requests.find({'network.groups': groupId }).toArray();
        requests = requests.concat(groupRequests)
    }

    const uniqueRequests = requests.filter((value, index) => {
        const _value = JSON.stringify(value);
        return index === requests.findIndex(obj => {
          return JSON.stringify(obj) === _value;
        });
      });

    await Promise.all(uniqueRequests.map(async (r) => {
        r.user_name = (await Users.find({ _id: new ObjectId(r.user_id) }).toArray())[0].name 
    }));

    res.json({requests: uniqueRequests});
});

api.post('/createOrEditRequest', async (req, res) => {
    const { userId, request, requestId } = req.body
    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!request) return res.status(400).json({error: 'Invalid request. request is a required property'});

    const {
        date, 
        description,
        duration,
        location,
        network
    } = request;
    if (!date) return res.status(400).json({error: 'Invalid request. request object must include date'});
    if (!description) return res.status(400).json({error: 'Invalid request. request object must include description'});
    if (!duration) return res.status(400).json({error: 'Invalid request. request object must include duration'});
    if (!location) return res.status(400).json({error: 'Invalid request. request object must include location'});
    if (!network || !Array.isArray(network)) return res.status(400).json({error: 'Invalid request. request object must include array-type network'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});

    const formattedNetwork = { connections: [], groups: [], communityGroups: []}
    for (const recipient of network) {
        switch (recipient.header) {
            case 'Connections':
                formattedNetwork.connections.push(new ObjectId(recipient.data._id));
                break;
            case 'My Groups':
                formattedNetwork.groups.push(new ObjectId(recipient.data._id));
                break;
            case 'My Community Groups':
                formattedNetwork.communityGroups.push(new ObjectId(recipient.data._id));
                break;
            default:
                return;
        }
    }

    const formattedRequest = {
        date: new Date(date),
        description,
        duration,
        location,
        network: formattedNetwork,
        creationDate: new Date(),
        user_id: users[0]._id,
    }

    if (requestId) {
        const requests = await Requests.find({_id: new ObjectId(requestId)}).toArray();
        if (!requests.length) return res.status(404).json({error: `No request with _id: ${requestId} found.`});

        await Requests.updateOne({_id: new ObjectId(requestId)}, { $set: formattedRequest })
    } else {
        await Requests.insertOne(formattedRequest)
    }

    const user = await formatUser(users[0])
    res.json({user})
});

api.post('/groups/delete', async (req, res) => {
    const { userId, groupId } = req.body
  // console.log(userId)
  // console.log(groupId)
    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!groupId) return res.status(400).json({error: 'Invalid request. groupId is a required property'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});

    const groups = await Groups.find({_id: new ObjectId(groupId)}).toArray();
    if (!groups.length) return res.status(404).json({error: `No group with _id: ${groupId} found.`});

    await Groups.deleteOne({ _id: new ObjectId(groups[0]._id) })

    const user = await formatUser(users[0])
    res.json({user})
});

api.post("/signin", async (req, res) => {
    const { mobileNumber } = req.body;

    if (!mobileNumber) return res.status(400).json({error: 'Invalid request. mobileNumber is a required property'});

    const users = await Users.find({number: mobileNumber}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with number: ${mobileNumber} found.`});

    const user = await formatUser(users[0])

    res.json({user});
});

api.post("/signout", async (req, res) => {
    res.json({});
});

api.post("/updateUser", async (req, res) => {
    const { userId, updatedName, updatedNumber } = req.body;

    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!updatedName) return res.status(400).json({error: 'Invalid request. updatedName is a required property'});
    if (!updatedNumber) return res.status(400).json({error: 'Invalid request. updatedNumber is a required property'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});

    let user = users[0]
    await Users.updateOne({_id: new ObjectId(userId)}, { $set: { name: updatedName, number: updatedNumber } })
    user.name = updatedName;
    user.number = updatedNumber;
    user = await formatUser(user)

    res.json({user});
});

api.post("/addConnection", async (req, res) => {
    const { userId, connectionName, connectionNumber } = req.body;

    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!connectionName) return res.status(400).json({error: 'Invalid request. connectionName is a required property'});
    if (!connectionNumber) return res.status(400).json({error: 'Invalid request. connectionNumber is a required property'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});

    const connections = await Users.find({number: connectionNumber}).toArray();
    if(!connections.length) return res.status(404).json({error: `No user with name: ${connectionName} and number: ${connectionNumber} found.`});

    let user = users[0]
    const connection = connections[0]
    if (user.connections?.includes(connection._id)) return res.status(400).json({error: `User has already added this connection.`});
    if (user._id.equals(connection._id)) return res.status(400).json({error: 'User cannot add themselves as a connection'});

    const newConnections = user.connections?.concat([connection._id]) ?? [connection._id];
    user.connections = newConnections

    await Users.updateOne({_id: new ObjectId(userId)}, { $set: { connections: newConnections } })
    
    user = await formatUser(user)

    res.json({user});
});

api.post("/removeConnection", async (req, res) => {
    const { userId, connectionId } = req.body;

    if (!userId) return res.status(400).json({error: 'Invalid request. userId is a required property'});
    if (!connectionId) return res.status(400).json({error: 'Invalid request. connectionId is a required property'});

    const users = await Users.find({_id: new ObjectId(userId)}).toArray();
    if (!users.length) return res.status(404).json({error: `No user with _id: ${userId} found.`});

    const connections = await Users.find({_id: new ObjectId(connectionId)}).toArray();
    if(!connections.length) return res.status(404).json({error: `No user with _id: ${connectionId} and number: ${connectionNumber} found.`});

    let user = users[0]
    const connection = connections[0]
    const existingConnections = user.connections?.filter(conn => conn.equals(connection._id));
    if (!existingConnections.length) return res.status(400).json({error: `No Existing Connection. Add Connection between users before attempting to remove`});

    const newConnections = user.connections?.filter(conn => !conn.equals(connection._id));
    await Users.updateOne({_id: new ObjectId(userId)}, { $set: { connections: newConnections } });
    user.connections = newConnections

    const userGroups = await Groups.find({user_id: new ObjectId(user._id)}).toArray();
    for (const group of userGroups) {
        const existingMembers = group.members.filter(conn => conn.equals(connection._id));
        if (existingMembers.length) {
            const newMembers = group.members.filter(conn => !conn.equals(connection._id));
            await Groups.updateOne({_id: new ObjectId(group._id)}, { $set: { members: newMembers } });
        }
    }
    
    user = await formatUser(user)
    res.json({user});
});

api.post("/signup", async (req, res) => {
    const { mobileNumber, fullName } = req.body;
  // console.log(mobileNumber);
  // console.log(fullName);

    if (!mobileNumber) return res.status(400).json({error: 'Invalid request. mobileNumber is a required property'});
    if (!fullName) return res.status(400).json({error: 'Invalid request. fullName is a required property'});

    const users = await Users.find({number: mobileNumber}).toArray();
    if (users.length) return res.status(400).json({error: `Invalid request. User with number: ${mobileNumber} already exists.`});

    const { insertedId } = await Users.insertOne({number: mobileNumber, name: fullName})
    
    res.json({user: {_id: insertedId, name: fullName, number: mobileNumber}});
});

export default initApi;
