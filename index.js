const API_BUILDER = require('claudia-api-builder'),
	  AWS = require('aws-sdk'),
	  AmazonCognitoIdentity = require('amazon-cognito-identity-js');
	
const api = new API_BUILDER(),
	// DML(Data Manipulation Language): query, put, delete 등 dynamo 테이블 안에 있는 데이터를 다루기 위한 라이브러리
	dynamoDB = new AWS.DynamoDB.DocumentClient(),
	s3 = new AWS.S3(),
	BUCKET_NAME = 'your_bucket_name';
	
module.exports = api;

const moment = require('moment');
const TIME_ZONE = '+09:00'; // Asia/Seoul UTC offset
const TIME_FORMAT = 'YYYY-MM-DDTHH:mm:ss';

// 연동 자격 증명 풀 ID
const USER_POOL_ID = 'your_user_pool_id';
const CLIENT_ID = 'your_client_id';

// 연동 자격 증명 풀과 사용자 풀의 앱 클라이언트 ID
var userPoolData = {
    UserPoolId: USER_POOL_ID,
    ClientId: CLIENT_ID
};

// Cognito를 이용해 자격 확인 및 유저풀 객체 할당
var userPool = new AmazonCognitoIdentity.CognitoUserPool(userPoolData);

// Cognito 함수를 이용하기 위한 객체 할당
var cognitoidentityserviceprovider = new AWS.CognitoIdentityServiceProvider();

// Cognito의 사용자 풀에 등록된 유저 인증
api.registerAuthorizer('auth', {
	// 사용자 풀 ARN
	providerARNs: ['your_user_pool_arn']
});

const TABLE_NAME = {signHistory: 'SignHistory'};

// ========================================================================================================

/*
 * 사용자 등록
 * @param: {String} username (means ID)
 * @param: {String} password
 * @param: {String} name
 * @param: {String} email (only naver)
 */
api.post('/user', function(request){
	var {username, password, name, email} = request.body;
	
	let cognitoParams = {
		ClientId: CLIENT_ID,
		Username: username,
		Password: password,
		UserAttributes: [
			{
				Name: 'name',
				Value: name
			},
			{
				Name: 'email',
				Value: email
			}
		]
	};
	return signUpToCognito(cognitoParams);
	
	
	function signUpToCognito(params){
		return new Promise((resolve, reject) => {
			cognitoidentityserviceprovider.signUp(params, function(err, data){
				if(err){
					reject(err);
				}
				else{
					resolve(data);
				}
			});
		}).then(result => {
			return result;
		}).catch(err => {
			console.warn(err);
			return err;
		});
	}
});

/*
 * 사용자 Sign In & Out 기록
 * @param {String} action (In or Out)
 */
api.post('/userSignAction', function(request){	
	var {username, action} = request.body;
	var now = moment().utcOffset(TIME_ZONE).format(TIME_FORMAT);
	
	return userActionSave(username, now, action);
	
	function userActionSave(username, now, action){
		let params = {
			TableName: TABLE_NAME.signHistory,
			Item: {
				Username: username,
				Timestamp: now,
				Action: action
			}
		};
		return dynamoDB.put(params).promise().then(response => {
			return {statusCode: 200, message: 'OK'};
		}).catch(err => {
			console.log(`사용자(${username})의 Sign 기록(${action})이 저장되지 않음. detail: ${err}`);
			return {statusCode: 500, message: 'Internal Server Error'};
		});
	}
});

/*
 * 사용자 Sign 기록 조회
 * 사용자 별, 기간 별 조회하도록 해야하나, 임시 페이지므로 모든 사용자의 모든 기간의 기록을 가져옴
 * @param none
 */
api.get('/usersSign', function(request){
	
	return getAllUsersSignHistory();
	
	function getAllUsersSignHistory(){
		let params = {
			TableName: TABLE_NAME.signHistory
		};
		return dynamoDB.scan(params).promise().then(response => {
			return response.Items;
		}).catch(err => {
			console.log(`모든 사용자의 Sign 기록을 조회하지 못함. detail: ${err}`);
			return {statusCode: 500, message: 'Internal Server Error'};
		});
	}
}, {cognitoAuthorizer: 'auth'});

/*
 * 이미지 업로드
 * @param {String} imageName
 * @param {Binary} imageContent
 * @param {String || Boolean} force (if already exist - yes: overwrite. no: notify)
 */
api.post('/image', async function(request){
	var apiCaller = request.context.authorizer.claims;
	var apiCallerUsername = apiCaller['cognito:username'];
	var {imageName, imageContent, force} = request.body;
	
	var isForceUpload = checkForce(force);
	
	// 강제 업로드 = 덮어쓰기, 버전 업
	if(isForceUpload){
		return uploadToS3(apiCallerUsername, imageName, imageContent);
	}
	// 중복 확인 후 업로드
	else {
		var isExist = await checkAlreadyExists(apiCallerUsername, imageName);
		if(isExist){
			return uploadToS3(apiCallerUsername, imageName, imageContent);
		}
		else {
			return {statusCode: 409, message: 'Already exists'};
		}
	}
	
	function checkForce(force){
		switch(force){
			case 'YES':
			case 'yes':
			case 'y':
			case 'OK':
			case 'ok':
			case 'TRUE':
			case 'True':
			case 'true':
			case true:
				return 1;
				
			case undefined:
			case 'NO':
			case 'no':
			case 'n':
			case 'FALSE':
			case 'False':
			case 'false':
			case false:
				return 0;
		}
	}

	function checkAlreadyExists(username, imageName){
		return new Promise((resolve, reject) => {
			var params = {
				Bucket: BUCKET_NAME,
				Key: `gallery/${username}/${imageName}`,
			};
			s3.getObject(params, function(err, data){
				if(err){
					reject(err);
				}
				else {
					resolve(data);
				}
			});
		}).then(result => {
			console.log(`사용자(${username})의 이미지 이름(${imageName}) 중복`);
			return 0;
		}).catch(err => {
			console.log(`중복 아님`);
			return 1;
		});
	}
	
	function uploadToS3(username, imageName, imageContent){
		var bufferedImage = Buffer.alloc(imageContent.length, imageContent, 'base64');
		
		return new Promise((resolve, reject) => {
			var s3PutParams = {
				Bucket: BUCKET_NAME,
				Key: `gallery/${username}/${imageName}`,
				Body: bufferedImage
			};
			s3.putObject(s3PutParams, (err, data) => {
				if(err)
					reject(err);
				else
					resolve(data);
			});
		}).then(result => {
			console.log(result);
			return {statusCode: 200, message: 'OK'};
		}).catch(err => {
			console.warn(`S3에 이미지를 저장하지 못함. detail: ${err}`);
			return {statusCode: 500, message: 'Internal Server Error'};
		});
	}
}, {cognitoAuthorizer: 'auth'});

/*
 * 모든 사용자의 모든 이미지 조회
 * @param none
 */
api.get('/images', function(request){
	
	return getUsersImages();
	
	function getUsersImages(){
		var params = {
			Bucket: BUCKET_NAME,
            Prefix: `gallery`
		};
		return s3.listObjects(params).promise().then(response => {
			return response.Contents.map(index => {
				var parsing = index.Key.split('/');
				var [uploader, imageName] = [parsing[1], parsing[2]];
				var lastModified = moment(index.LastModified).utcOffset(TIME_ZONE).format(TIME_FORMAT);
				
				return {imageName, size: index.Size, path: index.Key, uploader, lastModified};
			}); 
		}).catch(err => {
			return err;
		});
	}
}, {cognitoAuthorizer: 'auth'});